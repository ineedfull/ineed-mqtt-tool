import { defineConfig } from '@playwright/test';
import base from './playwright.typography.config.js';
export default defineConfig({...base,use:{...base.use,screenshot:'only-on-failure'},testMatch:['formLayout.spec.js'],timeout:120000});
