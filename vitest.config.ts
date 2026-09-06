import { defineConfig } from 'vitest/config';

// 单元测试运行在 Node 环境（CanvasEngine 纯函数不依赖 DOM）。
// 组件测试（M2 后续）如需 DOM，可在对应文件顶部用 // @vitest-environment jsdom 覆盖。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
  },
});
