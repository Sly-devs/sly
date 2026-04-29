import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': '/src',
      // @x402/extensions imports `ajv/dist/2020` without a .js extension.
      // Node's CommonJS resolver finds it via package exports, but Vitest's
      // ESM resolver is stricter and needs the .js explicitly. The
      // production tsup build bundles ajv inline so this only affects tests.
      'ajv/dist/2020': 'ajv/dist/2020.js',
    },
  },
});

