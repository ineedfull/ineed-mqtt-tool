import assert from 'node:assert/strict';
import test from 'node:test';

import { getRuntimePresentation } from '../src/workspace/runtimePresentation.js';

test('runtime presentation preserves the canonical Electron copy', () => {
  assert.deepEqual(getRuntimePresentation('electron'), {
    runtimeLabel: 'Electron',
    buildLine: '基于 Vue 3 + Electron 构建',
    mqttLine: 'MQTT 通信：mqtt.js',
  });
});

test('runtime presentation preserves the canonical Tauri and Rust copy', () => {
  assert.deepEqual(getRuntimePresentation('tauri'), {
    runtimeLabel: 'Tauri',
    buildLine: '基于 Vue 3 + Tauri / Rust 构建',
    mqttLine: 'MQTT 通信：Rust 原生实现',
  });
});

test('runtime presentation uses neutral copy for an unknown runtime', () => {
  assert.deepEqual(getRuntimePresentation('  web-preview  '), {
    runtimeLabel: 'web-preview',
    buildLine: '基于 Vue 3 构建',
    mqttLine: 'MQTT 通信：运行时适配实现',
  });
});
