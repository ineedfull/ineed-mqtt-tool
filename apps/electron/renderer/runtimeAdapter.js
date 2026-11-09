import {
  normalizeMessageBatch,
  normalizeMqttStatus,
} from '@ineed-mqtt-tool/mqtt-contract';
import { assertRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';

const REQUIRED_BRIDGE_METHODS = Object.freeze([
  'db.getConnections',
  'db.saveConnection',
  'db.deleteConnection',
  'db.getMessageCounts',
  'db.getSubscriptions',
  'db.addSubscription',
  'db.removeSubscription',
  'mqtt.connect',
  'mqtt.disconnect',
  'mqtt.subscribe',
  'mqtt.unsubscribe',
  'mqtt.publish',
  'mqtt.onMessages',
  'mqtt.onStatus',
  'db.saveMessages',
  'db.saveLogs',
  'db.queryHistoryMessages',
  'db.deleteHistoryMessage',
  'db.clearHistoryMessages',
  'db.queryHistoryLogs',
  'db.deleteHistoryLog',
  'db.clearHistoryLogs',
  'db.getPublishHistory',
  'db.savePublish',
  'db.getAllSettings',
  'db.saveSetting',
  'db.getStorageStats',
  'db.clearHistoryStorage',
  'clipboard.readText',
  'clipboard.writeText',
  'window.openHistory',
  'window.openExternal',
  'lifecycle.onBeforeClose',
  'update.check',
]);

function ownDataValue(target, key) {
  if (
    target === null
    || (typeof target !== 'object' && typeof target !== 'function')
  ) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function ownDataValueAtPath(target, dottedPath) {
  return dottedPath.split('.').reduce(ownDataValue, target);
}

function assertPreloadBridge(bridge) {
  const missing = REQUIRED_BRIDGE_METHODS.filter(
    method => typeof ownDataValueAtPath(bridge, method) !== 'function',
  );

  if (missing.length > 0) {
    throw new TypeError(
      `Electron preload bridge is missing required methods: ${missing.join(', ')}`,
    );
  }
}

function toPreloadPublishPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Array.from(payload);

  throw new TypeError('Electron MQTT payload must be a string or Uint8Array');
}

export function createElectronRuntimeAdapter(bridge) {
  assertPreloadBridge(bridge);

  const db = ownDataValue(bridge, 'db');
  const mqtt = ownDataValue(bridge, 'mqtt');
  const clipboard = ownDataValue(bridge, 'clipboard');
  const appWindow = ownDataValue(bridge, 'window');
  const lifecycle = ownDataValue(bridge, 'lifecycle');
  const update = ownDataValue(bridge, 'update');
  const updateMethods = Object.fromEntries(['getState', 'download', 'cancel', 'install', 'onState'].map(name => {
    const method = ownDataValue(update, name);
    return [name, typeof method === 'function' ? (...args) => Reflect.apply(method, update, args) : null];
  }));
  const unavailableUpdate = () => Promise.reject(new Error('应用内更新不可用'));
  const adapter = {
    runtimeName: 'electron',
    connection: {
      list: () => db.getConnections(),
      save: row => db.saveConnection(row),
      delete: id => db.deleteConnection(id),
      messageCounts: () => db.getMessageCounts(),
    },
    subscription: {
      list: connId => db.getSubscriptions(connId),
      add: row => db.addSubscription(row),
      remove: id => db.removeSubscription(id),
    },
    mqtt: {
      connect: connection => mqtt.connect(connection),
      disconnect: connId => mqtt.disconnect(connId),
      subscribe: (connId, topic, qos) => mqtt.subscribe(connId, topic, qos),
      unsubscribe: (connId, topic) => mqtt.unsubscribe(connId, topic),
      publish: (connId, topic, payload, qos, retain) => (
        mqtt.publish(connId, topic, toPreloadPublishPayload(payload), qos, retain)
      ),
      onMessages: handler => mqtt.onMessages(
        batch => handler(normalizeMessageBatch(batch)),
      ),
      onStatus: handler => mqtt.onStatus(
        status => handler(normalizeMqttStatus(status)),
      ),
    },
    history: {
      saveMessages: rows => db.saveMessages(rows),
      saveLogs: rows => db.saveLogs(rows),
      queryMessages: filter => db.queryHistoryMessages(filter),
      deleteMessage: id => db.deleteHistoryMessage(id),
      clearMessages: filter => db.clearHistoryMessages(filter),
      queryLogs: filter => db.queryHistoryLogs(filter),
      deleteLog: id => db.deleteHistoryLog(id),
      clearLogs: filter => db.clearHistoryLogs(filter),
    },
    publishHistory: {
      list: (connId, limit) => db.getPublishHistory(connId, limit),
      save: row => db.savePublish(row),
    },
    settings: {
      getAll: () => db.getAllSettings(),
      save: (key, value) => db.saveSetting(key, value),
    },
    storage: {
      stats: () => db.getStorageStats(),
      clearHistory: () => db.clearHistoryStorage(),
    },
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: value => clipboard.writeText(value),
    },
    window: {
      openHistory: (kind, connId) => appWindow.openHistory(kind, connId),
      openExternal: url => appWindow.openExternal(url),
    },
    lifecycle: {
      onBeforeClose: handler => lifecycle.onBeforeClose(handler),
    },
    update: {
      check: () => update.check(),
      getState: () => updateMethods.getState?.() ?? Promise.resolve({ phase: 'idle', supported: false }),
      download: () => (updateMethods.download ?? unavailableUpdate)(),
      cancel: () => (updateMethods.cancel ?? unavailableUpdate)(),
      install: () => (updateMethods.install ?? unavailableUpdate)(),
      onState: handler => updateMethods.onState?.(handler) ?? (() => {}),
    },
  };

  return assertRuntimeAdapter(adapter);
}
