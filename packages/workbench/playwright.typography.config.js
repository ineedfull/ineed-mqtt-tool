import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testMatch: ['typography.spec.js', 'subscriptionChat.spec.js', 'composer.spec.js', 'editorChrome.spec.js', 'messageViewport.spec.js'],
  testIgnore: [],
  workers: 1,
  projects: ['electron', 'tauri'].flatMap(runtime => ['chromium', 'webkit'].map(browser => ({
    name: `${runtime}-${browser}`,
    metadata: { runtime },
    use: {
      browserName: browser,
      channel: browser === 'chromium' ? 'chromium' : undefined,
      baseURL: `http://127.0.0.1:${runtime === 'electron' ? 5173 : 5175}`,
    },
  }))),
  webServer: [base.webServer, {
    ...base.webServer,
    command: 'npm run dev:renderer -w @ineed-mqtt-tool/tauri -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
  }],
});
