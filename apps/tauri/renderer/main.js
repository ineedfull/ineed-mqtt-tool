import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import '@ineed-mqtt-tool/workbench/base.css';
import { configureRendererReadiness } from './readinessReporter.js';
import { createTauriRuntimeAdapter } from './runtimeAdapter.js';

const params = new URLSearchParams(window.location.search);
const readiness = window.__INEED_VISUAL_ADAPTER__ ? { invoke, configureVueApp() {}, markMounted() {}, reportBootstrapError() {} } : configureRendererReadiness({ challenge: params.get('ineedSmokeChallenge') || '', emit, eventTarget: window, invoke });
const adapter = window.__INEED_VISUAL_ADAPTER__ || createTauriRuntimeAdapter({ invoke: readiness.invoke, listen, readText, writeText });
const app = createWorkbench(adapter);
try { readiness.configureVueApp(app, { fault: params.get('ineedSmokeFault') }); app.mount('#app'); readiness.markMounted(document.querySelector('#app')); } catch (error) { readiness.reportBootstrapError(error); throw error; }
