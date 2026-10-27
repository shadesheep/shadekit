import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'node',
    css: true,
    // .mjs 原生 Node 测试由 npm test 的 node --test 阶段执行。
    exclude: ['docs/**', 'tests/**/*.test.mjs', 'node_modules/**'],
  },
});
