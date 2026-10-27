import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  test: {
    environment: 'jsdom',
    environmentMatchGlobs: [['server/**', 'node']],
    include: ['src/**/*.test.{js,jsx}', 'server/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ['./src/test-setup.js']
  }
});
