import { defineConfig } from 'vite';

// Relative base so dist/ works from any static host sub-path (GitHub Pages etc.)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
});
