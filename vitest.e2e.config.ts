import { configDefaults, defineConfig } from 'vitest/config';

/**
 * E2E 测试专属 Vitest 配置（与主单元测试 vitest.config.ts 彻底隔离）。
 * 仅扫描 tests/e2e 下的 .e2e.spec.{ts,tsx} 用例，避免在 M1-M3 开发期间阻塞 npm run check。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.spec.{ts,tsx}'],
    exclude: [...configDefaults.exclude],
    setupFiles: ['tests/e2e/helpers/vitestE2eSetup.ts'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
