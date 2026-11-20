import { defineConfig } from 'vite';

// Google2 生产页面以静态 index.html + 原生脚本为唯一形态，
// 这里只保留 Capacitor 需要的构建产物目录，不做任何框架接线。
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // index.html 内联脚本是生产源码（含大量中文），禁止压缩重写。
    minify: false,
    assetsInlineLimit: 0,
  },
});
