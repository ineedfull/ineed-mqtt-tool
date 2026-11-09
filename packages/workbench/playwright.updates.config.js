import { defineConfig } from '@playwright/test';
import base from './playwright.typography.config.js';

export default defineConfig({ ...base, testMatch: ['inAppUpdate.spec.js'] });
