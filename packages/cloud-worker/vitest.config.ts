import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workers 类型覆盖了全局 URL，fileURLToPath 需要 Node 的 string 形式，故显式取 href。
const workersShim = fileURLToPath(
  new URL('./test/shims/cloudflare-workers.ts', import.meta.url).href,
);

export default defineConfig({
  resolve: {
    alias: {
      // Node 下不存在 `cloudflare:workers`，用最小替身提供 DurableObject 基类。
      'cloudflare:workers': workersShim,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // 每个 worker 都会拉起独立的 workerd 进程（Miniflare + esbuild bundle）。
    // 两个并发时在 Windows 出现过 fork 意外退出（Worker exited unexpectedly），
    // 而 workerd 用例本身已是串行节奏，因此收敛到单 worker；保留 forks 的进程级隔离。
    maxWorkers: 1,
  },
});
