import { assertRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';

function ownDataValue(target, key) {
  return Object.getOwnPropertyDescriptor(target, key).value;
}

function wrapMethod(namespace, methodName) {
  const method = ownDataValue(namespace, methodName);
  return (...args) => Reflect.apply(method, namespace, args);
}

function wrapOptionalUpdateMethod(namespace, name, fallback) {
  const descriptor = Object.getOwnPropertyDescriptor(namespace, name);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`Invalid update capability: ${name}`);
  }
  const method = descriptor.value;
  return (...args) => Reflect.apply(method, namespace, args);
}

export function createRuntimeFacade(adapter) {
  assertRuntimeAdapter(adapter);

  const runtimeName = ownDataValue(adapter, 'runtimeName');
  const connection = ownDataValue(adapter, 'connection');
  const subscription = ownDataValue(adapter, 'subscription');
  const mqttNamespace = ownDataValue(adapter, 'mqtt');
  const history = ownDataValue(adapter, 'history');
  const publishHistory = ownDataValue(adapter, 'publishHistory');
  const settings = ownDataValue(adapter, 'settings');
  const storage = ownDataValue(adapter, 'storage');
  const clipboardNamespace = ownDataValue(adapter, 'clipboard');
  const windowNamespace = ownDataValue(adapter, 'window');
  const lifecycleNamespace = ownDataValue(adapter, 'lifecycle');
  const updateNamespace = ownDataValue(adapter, 'update');

  const db = Object.freeze({
    getConnections: wrapMethod(connection, 'list'),
    saveConnection: wrapMethod(connection, 'save'),
    deleteConnection: wrapMethod(connection, 'delete'),
    getMessageCounts: wrapMethod(connection, 'messageCounts'),
    getSubscriptions: wrapMethod(subscription, 'list'),
    addSubscription: wrapMethod(subscription, 'add'),
    removeSubscription: wrapMethod(subscription, 'remove'),
    saveMessages: wrapMethod(history, 'saveMessages'),
    saveLogs: wrapMethod(history, 'saveLogs'),
    queryHistoryMessages: wrapMethod(history, 'queryMessages'),
    deleteHistoryMessage: wrapMethod(history, 'deleteMessage'),
    clearHistoryMessages: wrapMethod(history, 'clearMessages'),
    queryHistoryLogs: wrapMethod(history, 'queryLogs'),
    deleteHistoryLog: wrapMethod(history, 'deleteLog'),
    clearHistoryLogs: wrapMethod(history, 'clearLogs'),
    getPublishHistory: wrapMethod(publishHistory, 'list'),
    savePublish: wrapMethod(publishHistory, 'save'),
    getAllSettings: wrapMethod(settings, 'getAll'),
    saveSetting: wrapMethod(settings, 'save'),
    getStorageStats: wrapMethod(storage, 'stats'),
    clearHistoryStorage: wrapMethod(storage, 'clearHistory'),
  });
  const mqtt = Object.freeze({
    connect: wrapMethod(mqttNamespace, 'connect'),
    disconnect: wrapMethod(mqttNamespace, 'disconnect'),
    subscribe: wrapMethod(mqttNamespace, 'subscribe'),
    unsubscribe: wrapMethod(mqttNamespace, 'unsubscribe'),
    publish: wrapMethod(mqttNamespace, 'publish'),
    onMessages: wrapMethod(mqttNamespace, 'onMessages'),
    onStatus: wrapMethod(mqttNamespace, 'onStatus'),
  });
  const clipboard = Object.freeze({
    readText: wrapMethod(clipboardNamespace, 'readText'),
    writeText: wrapMethod(clipboardNamespace, 'writeText'),
  });
  const window = Object.freeze({
    openHistory: wrapMethod(windowNamespace, 'openHistory'),
    openExternal: wrapMethod(windowNamespace, 'openExternal'),
  });
  const lifecycle = Object.freeze({
    onBeforeClose: wrapMethod(lifecycleNamespace, 'onBeforeClose'),
  });
  const update = Object.freeze({
    check: wrapMethod(updateNamespace, 'check'),
    getState: wrapOptionalUpdateMethod(updateNamespace, 'getState', async () => ({ phase: 'idle', supported: false })),
    onState: wrapOptionalUpdateMethod(updateNamespace, 'onState', () => () => {}),
    download: wrapOptionalUpdateMethod(updateNamespace, 'download', async () => { throw new Error('应用内更新不可用'); }),
    cancel: wrapOptionalUpdateMethod(updateNamespace, 'cancel', async () => { throw new Error('取消下载不可用'); }),
    install: wrapOptionalUpdateMethod(updateNamespace, 'install', async () => { throw new Error('应用内安装不可用'); }),
  });

  return Object.freeze({ runtimeName, db, mqtt, clipboard, window, lifecycle, update });
}
