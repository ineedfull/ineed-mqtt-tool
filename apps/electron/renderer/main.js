import { createUnavailableRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
import { createElectronRuntimeAdapter } from './runtimeAdapter.js';

const adapter = window.ineedMqttAdapter
  || (window.ineedMqtt
    ? createElectronRuntimeAdapter(window.ineedMqtt)
    : createUnavailableRuntimeAdapter('electron-preview'));
createWorkbench(adapter).mount('#app');
