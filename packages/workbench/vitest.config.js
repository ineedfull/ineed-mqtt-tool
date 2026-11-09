import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['tests/components/**/*.test.js'],
    environment: 'jsdom',
    clearMocks: true,
    setupFiles: ['./tests/components/setup.js'],
  },
});
