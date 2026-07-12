import { defineConfig } from 'vitest/config';
import path from 'node:path';

const vitestConfig = defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      '@lobehub/fluent-emoji': path.resolve(
        __dirname,
        'tests/mocks/lobehub-fluent-emoji.tsx',
      ),
    },
  },
  test: {
    server: {
      deps: {
        inline: ['@lobehub/fluent-emoji', '@lobehub/ui'],
      },
    },
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15_000,
    exclude: ['.next/**', 'coverage/**', 'dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      all: false,
      include: ['lib/server/**/*.ts'],
      exclude: [
        '.next/**',
        'coverage/**',
        'dist/**',
        'app/**',
        'tests/**',
        'next-env.d.ts',
        'next.config.ts',
        'vitest.config.ts',
        'vitest.setup.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 70,
        statements: 90,
      },
    },
  },
});

export default vitestConfig;
