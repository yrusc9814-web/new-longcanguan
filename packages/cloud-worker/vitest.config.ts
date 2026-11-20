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
  },
});
