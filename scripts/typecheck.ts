/**
 * 类型检查入口。
 *
 * 本仓库的设计前提是**零运行时依赖**:所有测试与实现只用 `node:*` 内置模块,
 * 靠 Node 24 的原生类型擦除直接运行 `.ts`。因此 `node_modules/` 通常不存在,
 * `tsc` 也就不可用。
 *
 * 这个脚本的存在是为了把「类型检查」从一个**会硬崩的 npm script**
 *(原先直接 `node node_modules/typescript/bin/tsc`,没装依赖就
 * `MODULE_NOT_FOUND` 抛栈)变成一个**有意义的可选步骤**:
 *
 *   - 有 `typescript` → 真跑 `tsc --noEmit`,把退出码透传;
 *   - 没有 → 打印「已跳过」并**退出 0**,因为「没装可选开发依赖」
 *     不是代码缺陷,不该让 CI 红。
 *
 * 这样 `npm run typecheck` 在任何环境下都是可执行且语义正确的。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tscJs = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const tscCmd = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

if (existsSync(tscJs)) {
  console.log('[typecheck] 使用 node_modules/typescript 执行 tsc --noEmit');
  const r = spawnSync(process.execPath, [tscJs, '-p', join(ROOT, 'tsconfig.json'), '--noEmit'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

if (existsSync(tscCmd)) {
  console.log('[typecheck] 使用 node_modules/.bin/tsc 执行');
  const r = spawnSync(tscCmd, ['-p', join(ROOT, 'tsconfig.json'), '--noEmit'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(r.status ?? 1);
}

console.log('[typecheck] 已跳过:未安装 typescript(本仓库默认零依赖)。');
console.log('[typecheck] 需要静态类型检查时执行:  npm i -D typescript && npm run typecheck');
/*
 * 退出 0 是刻意的:缺可选开发依赖 ≠ 代码有问题。
 * 运行期的正确性由 `node scripts/verify.ts --all` 负责,那才是本仓库的门禁。
 */
process.exit(0);