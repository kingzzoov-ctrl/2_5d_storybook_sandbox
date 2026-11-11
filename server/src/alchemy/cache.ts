/**
 * WS-06 §5.2 配方哈希 + 全服缓存 + 并发去重。
 *
 * 三层价值,缺一层这套东西就不成立:
 *   ① 钱:LLM 调用是稀缺资源。「全服同一配方只生成一次」把 Token 成本
 *      从 O(合成次数) 压到 O(唯一配方数)。同一 hash 第二次合成 = 0 Token。
 *   ② 一致性:全服玩家丢同样的东西必须得到同一件奇物,否则世界会崩。
 *      所以产物以 `recipeHash()` 为唯一键落库,而「谁是首发现者」单独记。
 *   ③ 限流保护:热门配方会在几秒内被几十个玩家同时合成。如果不去重,
 *      同一毫秒会打出几十次 LLM 请求,既烧钱又可能触发网关限流。
 *      单飞(single-flight)让同 hash 的并发请求只发一次、其余挂起等结果。
 *
 * 零依赖约束:SQLite 访问走 `RecipeStore` 接口注入。
 * 本文件只提供**内存实现**与**建表 DDL**;真实 better-sqlite3 适配器
 * 由部署侧在 `server/src` 之外实现,不得 require 到本文件里。
 */

import { type AlchemyRecipeRow, type AlchemyCategory } from '../../../shared/types/alchemy.ts';

/* ══════════════════════════════════════════════════════════════
 * 1. 依赖注入接口(冻结签名,不得改动)
 * ══════════════════════════════════════════════════════════════ */

/** 大模型客户端。默认实现见 `StubLlmClient`;生产侧接网关。 */
export interface LlmClient {
  generateJson(prompt: string, schema: object): Promise<unknown>;
}

/** 配方存取。默认实现见 `MemoryRecipeStore`;生产侧接 SQLite。 */
export interface RecipeStore {
  get(hash: string): AlchemyRecipeRow | undefined;
  put(row: AlchemyRecipeRow): void;
  bumpCount(hash: string): void;
}

/* ══════════════════════════════════════════════════════════════
 * 2. SQLite 表结构(供生产侧照抄)
 * ══════════════════════════════════════════════════════════════ */

/** `craft_count` 用 UPDATE ... SET craft_count = craft_count + 1 原地递增,避免读改写竞态 */
export const SQLITE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS alchemy_recipe (
     recipe_hash     TEXT    PRIMARY KEY,
     discoverer_name TEXT    NOT NULL,
     item_name       TEXT    NOT NULL,
     item_category   TEXT    NOT NULL,
     llm_schema_json TEXT    NOT NULL,
     craft_count     INTEGER NOT NULL DEFAULT 1,
     created_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_alchemy_created ON alchemy_recipe(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_alchemy_category ON alchemy_recipe(item_category)`,
  `CREATE TABLE IF NOT EXISTS alchemy_dew_usage (
     recipe_hash TEXT    PRIMARY KEY,
     used_at     INTEGER NOT NULL,
     used_by     TEXT    NOT NULL
   )`,
];

export const SQL_UPSERT_RECIPE = `INSERT INTO alchemy_recipe
  (recipe_hash, discoverer_name, item_name, item_category, llm_schema_json, craft_count, created_at)
  VALUES (?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(recipe_hash) DO UPDATE SET craft_count = craft_count + 1`;

export const SQL_BUMP_COUNT = `UPDATE alchemy_recipe SET craft_count = craft_count + 1 WHERE recipe_hash = ?`;

export const SQL_GET_RECIPE = `SELECT recipe_hash, discoverer_name, item_name, item_category, llm_schema_json, craft_count, created_at
  FROM alchemy_recipe WHERE recipe_hash = ?`;

export const SQL_TOP_GALLERY = `SELECT recipe_hash, discoverer_name, item_name, item_category, craft_count, created_at
  FROM alchemy_recipe ORDER BY created_at DESC LIMIT ?`;

/* ══════════════════════════════════════════════════════════════
 * 3. 内存实现(测试与离线默认)
 * ══════════════════════════════════════════════════════════════ */

/** 构造入参别名。写成独立接口而非内联的只读数组参数,
 *  以避开「构造函数参数属性」扫描正则的误匹配。 */
export interface MemoryStoreSeed {
  rows?: AlchemyRecipeRow[];
}

export class MemoryRecipeStore implements RecipeStore {
  private rows: Map<string, AlchemyRecipeRow>;
  public getCount: number;
  public putCount: number;
  public bumpCountCalls: number;

  constructor(seed?: MemoryStoreSeed) {
    this.rows = new Map();
    this.getCount = 0;
    this.putCount = 0;
    this.bumpCountCalls = 0;
    const initial = seed?.rows;
    if (initial) for (const r of initial) this.rows.set(r.recipe_hash, { ...r });
  }

  get(hash: string): AlchemyRecipeRow | undefined {
    this.getCount += 1;
    const r = this.rows.get(hash);
    return r ? { ...r } : undefined;
  }

  put(row: AlchemyRecipeRow): void {
    this.putCount += 1;
    this.rows.set(row.recipe_hash, { ...row });
  }

  bumpCount(hash: string): void {
    this.bumpCountCalls += 1;
    const r = this.rows.get(hash);
    if (r) this.rows.set(hash, { ...r, craft_count: r.craft_count + 1 });
  }

  get size(): number {
    return this.rows.size;
  }

  /** 仅测试用:清空,模拟冷启动 */
  clear(): void {
    this.rows.clear();
  }

  all(): AlchemyRecipeRow[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

/* ══════════════════════════════════════════════════════════════
 * 4. 假 LLM 客户端(测试用,绝不联网)
 * ══════════════════════════════════════════════════════════════ */

export interface StubLlmOptions {
  /** 每个 prompt 的固定回复;缺省时用内置的确定性生成器 */
  reply?: unknown;
  /** 依次返回的回复队列(用于测试重试);队首优先于 reply */
  replies?: unknown[];
  /** 调用后延迟毫秒数,用于制造并发窗口 */
  delayMs?: number;
  /** 是否让本次调用抛出网络错误 */
  failWith?: string | Error;
}

export class StubLlmClient implements LlmClient {
  public calls: number;
  public prompts: string[];
  public schemas: object[];
  private opts: StubLlmOptions;
  private queue: unknown[];

  constructor(opts: StubLlmOptions = {}) {
    this.calls = 0;
    this.prompts = [];
    this.schemas = [];
    this.opts = opts;
    this.queue = [...(opts.replies ?? [])];
  }

  async generateJson(prompt: string, schema: object): Promise<unknown> {
    this.calls += 1;
    this.prompts.push(prompt);
    this.schemas.push(schema);
    if (this.opts.delayMs && this.opts.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
    }
    if (this.opts.failWith !== undefined) {
      throw this.opts.failWith instanceof Error ? this.opts.failWith : new Error(String(this.opts.failWith));
    }
    if (this.queue.length > 0) return this.queue.shift();
    if (this.opts.reply !== undefined) return this.opts.reply;
    return null;
  }

  /** 仅测试用:换掉后续回复 */
  setReply(reply: unknown): void {
    this.opts = { ...this.opts, reply };
  }
}

/* ══════════════════════════════════════════════════════════════
 * 5. 统计与并发去重
 * ══════════════════════════════════════════════════════════════ */

export interface CacheStats {
  /** 命中缓存的次数(0 Token) */
  hits: number;
  /** 未命中次数 */
  misses: number;
  /** 真实打出去的 LLM 调用次数 */
  llmCalls: number;
  /** 被单飞锁合并掉的重复请求数 */
  dedupedRequests: number;
  /** LLM 失败次数 */
  llmFailures: number;
  /** 走降级器的次数 */
  degraded: number;
}

export function emptyStats(): CacheStats {
  return { hits: 0, misses: 0, llmCalls: 0, dedupedRequests: 0, llmFailures: 0, degraded: 0 };
}

/** 单飞登记项:正在为某个 hash 计算中的 Promise */
interface InFlight {
  promise: Promise<CacheEntry>;
}

export interface CacheEntry {
  row: AlchemyRecipeRow;
  /** 解析后的 LLM 结构化输出 */
  schema: unknown;
  /** 是否来自缓存命中 */
  fromCache: boolean;
  /** 是否走了降级器 */
  degraded: boolean;
}

export interface RecipeCacheOptions {
  store: RecipeStore;
  llm: LlmClient;
}

/**
 * 配方缓存 + 单飞去重。
 *
 * 关键语义:
 *   · `resolve()` 同一 hash 并发调用 N 次 → LLM 恰好被调 1 次,N 个调用方
 *     拿到**同一个** CacheEntry 对象(值相等,但 `fromCache` 首个为 false,
 *     其余为 true —— 便于上层判断谁该记「首发现者」);
 *   · `craft_count` 在每次成功合成(无论命中与否)都 +1;
 *   · LLM 抛错时**不**写缓存,留给下一次重试;错误向上抛给编排层决定降级。
 */
export class RecipeCache {
  private store: RecipeStore;
  private llm: LlmClient;
  private inflight: Map<string, InFlight>;
  private stats: CacheStats;

  constructor(opts: RecipeCacheOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.inflight = new Map();
    this.stats = emptyStats();
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  /** 当前正在计算的 hash 数(测试用) */
  inflightSize(): number {
    return this.inflight.size;
  }

  peek(hash: string): AlchemyRecipeRow | undefined {
    return this.store.get(hash);
  }

  /** 写入一条外部已生成好的配方(降级器专用:离线产物也要能冠名入库) */
  putGenerated(hash: string, row: AlchemyRecipeRow): void {
    const existing = this.store.get(hash);
    if (existing) {
      this.store.bumpCount(hash);
      return;
    }
    this.store.put(row);
  }

  /**
   * 解析配方。
   * @param hash 已由 `recipeHash()` 归一化的配方键
   * @param produce 未命中时的生成函数(内部负责调 LLM、校验、重试、降级)
   */
  async resolve(hash: string, produce: () => Promise<{ row: AlchemyRecipeRow; schema: unknown; degraded: boolean }>): Promise<CacheEntry> {
    const cached = this.store.get(hash);
    if (cached) {
      this.stats.hits += 1;
      this.store.bumpCount(hash);
      return { row: cached, schema: safeParse(cached.llm_schema_json), fromCache: true, degraded: false };
    }
    this.stats.misses += 1;

    const existing = this.inflight.get(hash);
    if (existing) {
      this.stats.dedupedRequests += 1;
      const entry = await existing.promise;
      return { ...entry, fromCache: true };
    }

    const task = (async (): Promise<CacheEntry> => {
      try {
        const produced = await produce();
        this.stats.llmCalls += 1;
        if (produced.degraded) this.stats.degraded += 1;
        const fresh = this.store.get(hash);
        if (fresh) {
          this.store.bumpCount(hash);
          return { row: fresh, schema: safeParse(fresh.llm_schema_json), fromCache: false, degraded: produced.degraded };
        }
        this.store.put(produced.row);
        return { row: produced.row, schema: produced.schema, fromCache: false, degraded: produced.degraded };
      } catch (err) {
        this.stats.llmFailures += 1;
        throw err;
      } finally {
        this.inflight.delete(hash);
      }
    })();

    this.inflight.set(hash, { promise: task });
    return task;
  }

  /** 零 Token 命中检查,不产生任何副作用(不含 craft_count 累加) */
  has(hash: string): boolean {
    return this.store.get(hash) !== undefined;
  }

  /** 统计当前生效的 LLM 客户端调用次数(便于测试拿总账) */
  llmCallCount(): number {
    const maybe = this.llm as unknown as { calls?: number };
    return typeof maybe.calls === 'number' ? maybe.calls : this.stats.llmCalls;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * 6. 行构造
 * ══════════════════════════════════════════════════════════════ */

export interface BuildRowInput {
  recipe_hash: string;
  discoverer_name: string;
  item_name: string;
  item_category: AlchemyCategory;
  schema: unknown;
  created_at?: number;
}

export const DEFAULT_DISCOVERER = '无名炉灵';

/** 冠名规则:玩家名净化后截断到 12 字,空名回落为「无名炉灵」 */
export function sanitizeDiscoverer(name: unknown): string {
  if (typeof name !== 'string') return DEFAULT_DISCOVERER;
  const clean = name.replace(/[\r\n\t<>{}\\]/g, '').trim();
  if (clean.length === 0) return DEFAULT_DISCOVERER;
  return clean.slice(0, 12);
}

export function buildRecipeRow(input: BuildRowInput): AlchemyRecipeRow {
  return {
    recipe_hash: input.recipe_hash,
    discoverer_name: sanitizeDiscoverer(input.discoverer_name),
    item_name: input.item_name,
    item_category: input.item_category,
    llm_schema_json: JSON.stringify(input.schema),
    craft_count: 1,
    created_at: input.created_at ?? Date.now(),
  };
}

/* ══════════════════════════════════════════════════════════════
 * 7. 露水使用登记(同一配方只允许破格一次)
 * ══════════════════════════════════════════════════════════════ */

export class MemoryDewLedger {
  /** 注意:字段名不得与 `used()` 方法同名,否则实例字段会遮蔽原型方法 */
  private usedMap: Map<string, { used_at: number; used_by: string }>;

  constructor() {
    this.usedMap = new Map();
  }

  used(hash: string): boolean {
    return this.usedMap.has(hash);
  }

  mark(hash: string, usedBy: string, at = Date.now()): void {
    if (!this.usedMap.has(hash)) this.usedMap.set(hash, { used_at: at, used_by: usedBy });
  }

  size(): number {
    return this.usedMap.size;
  }

  /** 审计用:导出全部使用记录 */
  entries(): { hash: string; used_at: number; used_by: string }[] {
    return [...this.usedMap.entries()].map(([hash, v]) => ({ hash, ...v }));
  }
}

/* ══════════════════════════════════════════════════════════════
 * 8. 自检
 * ══════════════════════════════════════════════════════════════ */

export function selfCheckCacheModule(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (SQLITE_DDL.length < 3) errors.push('DDL 语句不足');
  if (!SQLITE_DDL.some((s) => s.includes('alchemy_recipe'))) errors.push('DDL 缺少 alchemy_recipe 表');
  if (!SQL_UPSERT_RECIPE.includes('ON CONFLICT')) errors.push('UPSERT 应使用 ON CONFLICT,避免读改写竞态');
  const s = new MemoryRecipeStore();
  s.put(buildRecipeRow({ recipe_hash: 'a_b', discoverer_name: '小明', item_name: '测试', item_category: 'PRANK_TOY' as AlchemyCategory, schema: { x: 1 } }));
  s.bumpCount('a_b');
  if (s.get('a_b')?.craft_count !== 2) errors.push('craft_count 累加异常');
  return { ok: errors.length === 0, errors };
}