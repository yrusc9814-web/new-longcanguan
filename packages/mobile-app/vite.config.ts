import { defineConfig } from 'vite';

// Vite 打包端内启动入口，Google2 页面和原生适配器仍直接加载。
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
