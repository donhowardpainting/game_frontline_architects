import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { environment: 'node', testTimeout: 60000 },
} as any);
