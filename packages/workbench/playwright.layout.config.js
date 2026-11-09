import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({
  ...base,
  testMatch: ['desktopLayout.spec.js', 'about.spec.js', 'modalKeyboard.spec.js'], testIgnore: [], workers: 1,
  use: { ...base.use, colorScheme: 'light', locale: 'zh-CN' },
  projects: [
    { name: 'chromium-layout', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'webkit-layout', use: { browserName: 'webkit' } },
  ],
});
