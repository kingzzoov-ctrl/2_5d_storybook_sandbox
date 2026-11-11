/**
 * 内容版本协商 —— 让「两端内容表不一致」在进门时就被拒绝,而不是静默渲染错误物品。
 *
 * ## 问题
 *
 * `server/src/net/delta.ts` 已经有 `PROTOCOL_VERSION`,并在收发两侧校验:
 *
 * ```ts
 * const version = r.u8();
 * if (version !== PROTOCOL_VERSION) throw new Error(`协议版本不匹配:${version}`);
 * ```
 *
 * 但那道门只管**代码**版本,不管**内容**版本。两种情况的差别很关键:
 *
 * - `PROTOCOL_VERSION` 变了 → 线格式变了 → 解码会失败 → **立刻暴露**;
 * - 内容表变了但代码没变 → 线格式完全合法 → **静默出错**。
 *
 * 后者的具体后果:蓝图里的 `obj` 是 12 位物品 ID。服务端认为 745 是
 * 「祭品·星屑之钥」,客户端的内容表里 745 是别的东西 —— 玩家看到的是
 * 一个完全合理、但**不对**的道具。没有异常、没有日志、没有画面异常。
 *
 * ## 方案
 *
 * 在进场握手时交换内容指纹(`content/registry.ts` 的 `contentFingerprints()`),
 * 由**服务端**判定是否放行:
 *
 * | 情况 | 处置 |
 * | :--- | :--- |
 * | 指纹一致 | 放行 |
 * | 指纹不一致 | 拒绝进场,给出双方指纹与差异摘要 |
 * | 客户端未提供指纹(旧客户端) | 按策略:严格模式拒绝 / 宽松模式放行并记告警 |
 *
 * ## 为什么不直接改 `delta.ts` 的线格式
 *
 * 那会改掉 `PROTOCOL_VERSION` 的语义(它现在表示线格式版本),
 * 并让既有 WS-07 测试全部需要重写。内容协商是**独立的关注点**,
 * 放在独立模块里用独立通道传,两者互不干扰:
 *
 *   - 线格式版本 → `decodePacket` 校验(已有)
 *   - 内容版本   → `verifyContentCompatibility()` 校验(本模块)
 *
 * ## 为什么指纹比对足够,不需要逐条 diff
 *
 * 指纹由 `canonicalize()` 规范化后计算,**只反映内容数据**。
 * 两端内容一致 ⟺ 指纹一致。若要不一致却指纹相同,需要在 FNV-1a 32 位上
 * 找到碰撞 —— 对「防止误配」这个目的而言,32 位足够(碰撞概率 2⁻³²)。
 * 真要逐条 diff,那是**诊断**需求,由 `content-lock.ts` 承担。
 */

import {
  contentFingerprints,
  contentFingerprintLine,
  type ContentFingerprints,
} from './registry.ts';

/**
 * 服务端指纹的**唯一**字符串形式。
 *
 * 早先这里手写成 `` `${version}-${overall}` ``(得 `1-fa111d71`),
 * 而 `registry.ts` 的 `contentFingerprintLine()` 是 `v1-fa111d71` ——
 * **同一个东西两种格式**。存档里写一种、握手比另一种,永远不相等,
 * 于是「内容一致」的判定恒为假。
 *
 * 这类错误的特征:两边看起来都对,单独看都不会怀疑,只有真的比一次才暴露。
 * 修法不是「小心一点」,而是让这里**只走同一处实现**。
 */
function serverFingerprintLine(): string {
  return contentFingerprintLine();
}

/* ═══════════════════════ 1. 兼容性策略 ═══════════════════════ */

/**
 * 内容不匹配时的处置策略。
 *
 * 之所以要做成策略而非写死:**开发期与运营期的正确行为相反**。
 *   - 开发期希望「方便地连上随便一台服务器」→ 宽松;
 *   - 运营期希望「宁可拒绝,不可错配」→ 严格。
 */
export const ContentPolicy = {
  /** 严格:指纹不一致或缺失一律拒绝进场。运营环境用这个。 */
  STRICT: 'STRICT',
  /** 宽松:不一致仍放行,但返回告警。开发环境用这个。 */
  LENIENT: 'LENIENT',
} as const;

export type ContentPolicy = (typeof ContentPolicy)[keyof typeof ContentPolicy];

/** 默认策略。默认严格 —— 错配的代价高于连不上的代价。 */
export const DEFAULT_CONTENT_POLICY: ContentPolicy = ContentPolicy.STRICT;

/* ═══════════════════════ 2. 握手载荷 ═══════════════════════ */

/** 客户端在进场时提供的自证信息。 */
export interface ClientContentClaim {
  /** 内容指纹算法版本。 */
  version: number;
  /** 内容合并指纹(8 位十六进制)。 */
  overall: string;
  /**
   * 可选的分区指纹,用于**诊断**:不一致时能指出是哪一块内容不同,
   * 而不是只说「指纹对不上」。
   */
  parts?: Partial<Record<'items' | 'mobs' | 'bosses' | 'modes', string>>;
}

/** 服务端本地的内容身份(由自己的内容表算出,不信任客户端)。 */
export function localContentClaim(): ClientContentClaim {
  const f = contentFingerprints();
  return { version: f.version, overall: f.overall, parts: { items: f.items, mobs: f.mobs, bosses: f.bosses, modes: f.modes } };
}

/* ═══════════════════════ 3. 判定 ═══════════════════════ */

/** 内容兼容性判定结果。 */
export interface ContentCompatResult {
  /** 是否允许进场。 */
  ok: boolean;
  /** 是否指纹一致。 */
  match: boolean;
  /** 使用的策略。 */
  policy: ContentPolicy;
  /** 拒绝原因(ok 为假时有值)。 */
  reason?: string;
  /** 告警(放行但有疑点时给出)。 */
  warning?: string;
  /** 服务端指纹,供客户端比对与日志。 */
  serverFingerprint: string;
  /** 差异诊断:哪些分区不同。 */
  differingParts?: string[];
}

/**
 * 判定客户端内容是否与服务端兼容。
 *
 * **只由服务端调用**,且服务端指纹取自**自己的**内容表 —— 绝不用客户端
 * 提供的值去比对客户端提供的值(那等于没校验)。
 *
 * @param claim 客户端声明的内容身份;`null` 表示旧客户端未提供。
 * @param policy 处置策略。
 */
export function verifyContentCompatibility(
  claim: ClientContentClaim | null,
  policy: ContentPolicy = DEFAULT_CONTENT_POLICY,
): ContentCompatResult {
  const local = localContentClaim();
  const serverFingerprint = serverFingerprintLine();

  /* — 客户端未提供指纹 — */
  if (!claim || typeof claim.overall !== 'string' || claim.overall.length === 0) {
    if (policy === ContentPolicy.STRICT) {
      return {
        ok: false,
        match: false,
        policy,
        reason: '客户端未提供内容指纹(旧客户端),严格模式下拒绝进场',
        serverFingerprint,
      };
    }
    return {
      ok: true,
      match: false,
      policy,
      warning: '客户端未提供内容指纹,已放行但无法确认内容一致性',
      serverFingerprint,
    };
  }

  /* — 算法版本不同:先按版本不匹配处理 — */
  if (claim.version !== local.version) {
    const reason = `内容指纹算法版本不匹配:客户端 v${claim.version} vs 服务端 v${local.version}`;
    if (policy === ContentPolicy.STRICT) {
      return { ok: false, match: false, policy, reason, serverFingerprint };
    }
    return { ok: true, match: false, policy, warning: reason, serverFingerprint };
  }

  /* — 指纹一致:放行 — */
  if (claim.overall === local.overall) {
    return { ok: true, match: true, policy, serverFingerprint };
  }

  /* — 指纹不一致:诊断出是哪一块不同 — */
  const differingParts: string[] = [];
  if (claim.parts) {
    for (const k of ['items', 'mobs', 'bosses', 'modes'] as const) {
      const cv = claim.parts[k];
      const sv = local.parts?.[k];
      if (cv !== undefined && sv !== undefined && cv !== sv) differingParts.push(k);
    }
  }
  const detail =
    differingParts.length > 0
      ? `不同的内容分区:${differingParts.join(', ')}`
      : '客户端未提供分区指纹,无法定位差异';
  const reason =
    `内容指纹不匹配:客户端 ${claim.version}-${claim.overall} vs 服务端 ${serverFingerprint}。` +
    `${detail}。物品 ID 是持久化身份 —— 两端内容不同会让同一 ID 指向不同物品,且不会报错。`;

  if (policy === ContentPolicy.STRICT) {
    return { ok: false, match: false, policy, reason, serverFingerprint, differingParts };
  }
  return { ok: true, match: false, policy, warning: reason, serverFingerprint, differingParts };
}

/* ═══════════════════════ 4. 存档侧的内容版本 ═══════════════════════ */

/**
 * 存档载入时的内容兼容性判定。
 *
 * 与网络握手同源,但**语义更严重**:网络错配当场可见(玩家马上发现不对),
 * 存档错配则是**持久化的数据损坏** —— 载入时把旧 ID 解释成新物品,
 * 一存回去就把错误固化了。
 *
 * 因此这里的默认行为是**拒绝载入**而不是告警放行,且给出可操作的提示。
 */
export interface SaveContentCheck {
  /** 是否允许载入。 */
  ok: boolean;
  /** 存档记录的内容指纹(旧存档可能没有)。 */
  saved: string | null;
  /** 当前内容指纹。 */
  current: string;
  /** 说明。 */
  message: string;
  /** 是否需要内容迁移。 */
  needsMigration: boolean;
}

/**
 * 校验存档记录的内容指纹。
 *
 * @param savedFingerprint 存档里记录的内容指纹行(如 `v1-fa111d71`);
 *   `null` / `undefined` 表示旧存档未记录。
 */
export function checkSaveContent(savedFingerprint: string | null | undefined): SaveContentCheck {
  const current = contentFingerprintLine();

  if (!savedFingerprint) {
    return {
      ok: false,
      saved: null,
      current,
      message:
        '存档未记录内容指纹(旧版本存档)。无法确认其中的物品 ID 与当前内容表一致 —— ' +
        '直接载入可能把旧 ID 解释成不同物品,并在下次保存时固化该错误。' +
        '需要一次显式的迁移(重新映射 ID 或人工确认)。',
      needsMigration: true,
    };
  }

  if (savedFingerprint === current) {
    return { ok: true, saved: savedFingerprint, current, message: '内容指纹一致', needsMigration: false };
  }

  return {
    ok: false,
    saved: savedFingerprint,
    current,
    message:
      `内容指纹不一致:存档 ${savedFingerprint} vs 当前 ${current}。` +
      '请按 docs/EXTENDING.md §5 决定迁移方式(删除物品需映射替代品,改 ID 等价于删+增)。',
    needsMigration: true,
  };
}

/* ═══════════════════════ 5. 握手编码(与线格式解耦) ═══════════════════════ */

/**
 * 把内容声明编码成一个紧凑的**纯字符串**,便于放进任何握手通道
 * (JSON 消息、query 参数、Colyseus 的 join options)而不改线格式。
 *
 * 格式:`v<版本>-<overall>[-<items>.<mobs>.<bosses>.<modes>]`
 * 例:`v1-fa111d71-0474ce21.624808c4.660c7c9b.b854dbfe`
 */
export function encodeContentClaim(claim: ClientContentClaim = localContentClaim()): string {
  const head = `v${claim.version}-${claim.overall}`;
  const p = claim.parts;
  if (!p) return head;
  const parts = [p.items, p.mobs, p.bosses, p.modes];
  if (parts.some((x) => typeof x !== 'string')) return head;
  return `${head}-${parts.join('.')}`;
}

/** 解析 `encodeContentClaim` 的输出。格式非法时返回 `null`(由调用方按策略处置)。 */
export function decodeContentClaim(s: string | null | undefined): ClientContentClaim | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const segs = s.split('-');

  /**
   * 段数必须恰好是 2(仅 overall)或 3(含分区)。
   *
   * **不能用 `< 2` 这种宽松下界**:那样 `v1-abc-a.b.c.d-extra` 会被接受 ——
   * `split('-')` 得 4 段,第 3 段 `a.b.c.d` 合法,尾部的 `-extra` 被静默丢弃。
   * 静默丢弃多余数据是危险的:发送方以为传了更多信息,接收方从未看到,
   * 而双方都不报错。宁可判为格式非法,让调用方显式处理。
   */
  if (segs.length !== 2 && segs.length !== 3) return null;

  const vRaw = segs[0];
  if (!vRaw.startsWith('v')) return null;
  const version = Number(vRaw.slice(1));
  if (!Number.isInteger(version) || version < 1) return null;

  const overall = segs[1];
  if (!/^[0-9a-f]{1,16}$/.test(overall)) return null;

  if (segs.length === 3) {
    const parts = segs[2].split('.');
    if (parts.length !== 4) return null;
    if (!parts.every((x) => /^[0-9a-f]{1,16}$/.test(x))) return null;
    return {
      version,
      overall,
      parts: { items: parts[0], mobs: parts[1], bosses: parts[2], modes: parts[3] },
    };
  }

  return { version, overall };
}

/** 人类可读的兼容性报告,供日志与管理后台用。 */
export function contentCompatReport(r: ContentCompatResult): string {
  const lines = [
    `内容兼容性:${r.ok ? (r.match ? '一致' : '放行(存疑)') : '拒绝'}`,
    `  策略    : ${r.policy}`,
    `  服务端   : ${r.serverFingerprint}`,
  ];
  if (r.differingParts && r.differingParts.length > 0) lines.push(`  差异分区 : ${r.differingParts.join(', ')}`);
  if (r.reason) lines.push(`  原因    : ${r.reason}`);
  if (r.warning) lines.push(`  告警    : ${r.warning}`);
  return lines.join('\n');
}

/** 指纹的完整分区视图,便于诊断时打印。 */
export function fingerprintBreakdown(f: ContentFingerprints = contentFingerprints()): string {
  return [
    `items  ${f.items}`,
    `mobs   ${f.mobs}`,
    `bosses ${f.bosses}`,
    `modes  ${f.modes}`,
    `─────────────────`,
    `overall ${f.overall}  (v${f.version})`,
  ].join('\n');
}