const RUNTIME_PRESENTATIONS = Object.freeze({
  electron: Object.freeze({
    runtimeLabel: 'Electron',
    buildLine: '基于 Vue 3 + Electron 构建',
    mqttLine: 'MQTT 通信：mqtt.js',
  }),
  tauri: Object.freeze({
    runtimeLabel: 'Tauri',
    buildLine: '基于 Vue 3 + Tauri / Rust 构建',
    mqttLine: 'MQTT 通信：Rust 原生实现',
  }),
});

export function getRuntimePresentation(runtimeName) {
  const runtimeLabel = String(runtimeName).trim();
  return RUNTIME_PRESENTATIONS[runtimeLabel.toLowerCase()] ?? {
    runtimeLabel,
    buildLine: '基于 Vue 3 构建',
    mqttLine: 'MQTT 通信：运行时适配实现',
  };
}
