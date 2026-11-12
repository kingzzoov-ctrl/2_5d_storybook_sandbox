/**
 * Vite 配置 —— 只服务客户端。
 *
 * ## 为什么引入 Vite
 *
 * 手册 L719 明确要求:「使用 Vite + Three.js 搭建 35° 正交相机舞台」。
 *
 * ## 为什么服务端**不**走 Vite
 *
 * 底座的价值有一大半在「零构建」:服务端 `node xxx.ts` 直接跑,
 * 没有 `tsc`、没有 `dist/`、没有构建产物与源码不同步的问题。
 * 这个性质**必须保住** —— 所以这里只配 `build:client`,不提供通用 `build`。
 *
 * ## 关键:允许 `.ts` 后缀的显式 import
 *
 * 全仓代码都写 `import x from './y.ts'`(Node 24 原生类型擦除要求显式后缀)。
 * Vite 默认解析这种路径没问题,但需要确认 `resolve.extensions` 不干扰。
 */

import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 把图集 PNG 拷进构建产物,并在缺失时**让构建失败**。
 *
 * ## 为什么图集现在提交进仓库了(2026-11-12 裁决)
 *
 * 早先图集只在 `_design/` 下,而 `.gitignore` 忽略 `_design/`(那里放的是
 * **参考原画**,不该随仓库分发)。图集本身性质不同 —— 它是**运行时资源**,
 * 是这个项目的核心美术资产。
 *
 * 那个做法的后果是:干净克隆的机器上找不到图集 ⇒ 插件只打印一行警告就继续
 * ⇒ 产物里没有图集、页面没有立牌、**而没有任何东西会失败**。
 * 这正是本项目反复出现的缺陷形态:**静默降级**。
 * 更糟的是核心美术资产**等于没有版本管理**,本地误删即不可恢复。
 *
 * 所以现在:图集移到仓库根的 `assets/`(已提交),并让缺失**构建失败**。
 *
 * ## 为什么缺失必须失败而不是警告
 *
 * 「没有图集场景也能跑」在开发期是优点,在交付期是陷阱 ——
 * 它把「资源没跟上」伪装成「一切正常」。宁可构建红,也不要产出一个
 * 玩家打开后发现没有立牌的站点。
 *
 * 确实要在没有图集的机器上构建(如纯逻辑冒烟):显式设
 * `ALLOW_MISSING_ATLAS=1` 放行 —— 让降级**必须被主动选择**。
 */
function copyAtlasPlugin(): Plugin {
  const SRC = join('assets', 'atlas_sprites.png');
  /* Vite 8 会按环境(client/ssr)各调一次 `closeBundle`,实测打印了两次。
     拷贝本身幂等,但重复日志会让人以为配了两遍插件 —— 加个守卫只做一次。 */
  let done = false;
  return {
    name: 'copy-atlas-sprites',
    /* `closeBundle` 在 outDir 写完(含 emptyOutDir 清空)之后跑,顺序才对 */
    closeBundle() {
      if (done) return;
      done = true;
      const outDir = join('dist', 'client');
      const dest = join(outDir, 'atlas_sprites.png');
      if (!existsSync(SRC)) {
        const detail = `图集不存在:${SRC}\n`
          + '  图集是**运行时资源**,已随仓库提交;干净克隆上应当存在。\n'
          + '  确实要跳过(例如只跑纯逻辑冒烟):设 ALLOW_MISSING_ATLAS=1';
        if (process.env['ALLOW_MISSING_ATLAS'] === '1') {
          console.warn(`  ⚠ ${detail}\n  (已设 ALLOW_MISSING_ATLAS=1 放行 —— 产物将不含立牌)`);
          return;
        }
        throw new Error(detail);
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(SRC, dest);
      console.log(`  ✓ 图集已拷入构建产物:${dest}`);
    },
  };
}

export default defineConfig({
  root: 'client',
  /* 相对路径,便于之后挂到任意子路径下(不写死 /) */
  base: './',
  plugins: [copyAtlasPlugin()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    /* 不生成 sourcemap 之外的额外产物;调试期需要 map 便于定位 */
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        /*
         * three 单独分包:它体积大且很少变,分开可以长期缓存。
         * 注意:此环境的 bundler 只接受**函数**形式的 manualChunks,
         * 对象形式会报 `manualChunks is not a function`。
         */
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  resolve: {
    /* 让 `./x` 也能解析到 `./x.ts` —— 老代码里偶有无后缀写法 */
    extensions: ['.ts', '.js', '.json'],
  },
});