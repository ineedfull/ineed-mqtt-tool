import { assertRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';
import { createApp } from 'vue';

import App from './App.vue';
import { runtimeAdapterKey } from './runtimeContext.js';

export function createWorkbench(adapter) {
  assertRuntimeAdapter(adapter);
  const app = createApp(App);
  app.provide(runtimeAdapterKey, adapter);
  return app;
}
