const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = Object.freeze({
  dbGetConnections: 'db:get-connections',
  dbSaveConnection: 'db:save-connection',
  dbDeleteConnection: 'db:delete-connection',
  dbGetMessageCounts: 'db:get-message-counts',
  dbGetSubscriptions: 'db:get-subscriptions',
  dbAddSubscription: 'db:add-subscription',
  dbRemoveSubscription: 'db:remove-subscription',
  dbSaveMessages: 'db:save-messages',
  dbSaveLogs: 'db:save-logs',
  dbQueryHistoryMessages: 'db:query-history-messages',
  dbDeleteHistoryMessage: 'db:delete-history-message',
  dbClearHistoryMessages: 'db:clear-history-messages',
  dbQueryHistoryLogs: 'db:query-history-logs',
  dbDeleteHistoryLog: 'db:delete-history-log',
  dbClearHistoryLogs: 'db:clear-history-logs',
  dbGetPublishHistory: 'db:get-publish-history',
  dbSavePublish: 'db:save-publish',
  dbGetAllSettings: 'db:get-all-settings',
  dbSaveSetting: 'db:save-setting',
  dbGetStorageStats: 'db:get-storage-stats',
  dbClearHistoryStorage: 'db:clear-history-storage',
  mqttConnect: 'mqtt:connect',
  mqttDisconnect: 'mqtt:disconnect',
  mqttSubscribe: 'mqtt:subscribe',
  mqttUnsubscribe: 'mqtt:unsubscribe',
  mqttPublish: 'mqtt:publish',
  mqttMessages: 'mqtt:messages',
  mqttStatus: 'mqtt:status',
  clipboardReadText: 'clipboard:read-text',
  clipboardWriteText: 'clipboard:write-text',
  windowOpenHistory: 'window:open-history',
  windowOpenExternal: 'window:open-external',
  lifecycleBeforeClose: 'lifecycle:before-close',
  lifecycleBeforeCloseAck: 'lifecycle:before-close-ack',
  updateCheck: 'update:check',
  updateState: 'update:state',
  updateDownload: 'update:download',
  updateCancel: 'update:cancel',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',
});

// Native close handshakes are short-lived; retain claims until this renderer exits.
const claimedBeforeCloseRequestIds = new Set();
let activeBeforeCloseDispose = null;

function assertHandler(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('event handler must be a function');
  }
}

function addRemovableListener(channel, handler) {
  assertHandler(handler);
  const listener = (_event, payload) => handler(payload);
  let disposed = false;

  ipcRenderer.on(channel, listener);
  return () => {
    if (disposed) return;
    disposed = true;
    ipcRenderer.removeListener(channel, listener);
  };
}

function normalizeError(error) {
  let name = 'Error';
  let message = 'Before-close handler failed';

  try {
    if (error?.name != null) name = String(error.name);
  } catch {
    // Keep the stable fallback when a rejected value has hostile accessors.
  }

  try {
    const candidate = error?.message ?? error;
    if (candidate != null) message = String(candidate);
  } catch {
    // Keep the stable fallback when a rejected value cannot be stringified.
  }

  return { name, message };
}

function acknowledgeBeforeClose(payload) {
  try {
    ipcRenderer.send(IPC_CHANNELS.lifecycleBeforeCloseAck, payload);
  } catch {
    // A destroyed renderer cannot acknowledge, but must not leak a rejection.
  }
}

function readBeforeCloseRequestId(request) {
  try {
    const requestId = request?.requestId;
    return typeof requestId === 'string' && requestId.trim() !== ''
      ? requestId
      : null;
  } catch {
    return null;
  }
}

function onBeforeClose(handler) {
  assertHandler(handler);
  if (activeBeforeCloseDispose !== null) {
    throw new Error('before-close handler is already registered');
  }

  const listener = async (_event, request = {}) => {
    const requestId = readBeforeCloseRequestId(request);
    if (requestId === null || claimedBeforeCloseRequestIds.has(requestId)) return;
    claimedBeforeCloseRequestIds.add(requestId);

    try {
      await handler(request);
      acknowledgeBeforeClose({ requestId, ok: true });
    } catch (error) {
      acknowledgeBeforeClose({
        requestId,
        ok: false,
        error: normalizeError(error),
      });
    }
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;

    try {
      ipcRenderer.removeListener(IPC_CHANNELS.lifecycleBeforeClose, listener);
    } finally {
      if (activeBeforeCloseDispose === dispose) activeBeforeCloseDispose = null;
    }
  };

  ipcRenderer.on(IPC_CHANNELS.lifecycleBeforeClose, listener);
  activeBeforeCloseDispose = dispose;
  return dispose;
}

const db = Object.freeze({
  getConnections: () => ipcRenderer.invoke(IPC_CHANNELS.dbGetConnections),
  saveConnection: connection => ipcRenderer.invoke(IPC_CHANNELS.dbSaveConnection, connection),
  deleteConnection: id => ipcRenderer.invoke(IPC_CHANNELS.dbDeleteConnection, id),
  getMessageCounts: () => ipcRenderer.invoke(IPC_CHANNELS.dbGetMessageCounts),
  getSubscriptions: connId => ipcRenderer.invoke(IPC_CHANNELS.dbGetSubscriptions, connId),
  addSubscription: subscription => ipcRenderer.invoke(IPC_CHANNELS.dbAddSubscription, subscription),
  removeSubscription: id => ipcRenderer.invoke(IPC_CHANNELS.dbRemoveSubscription, id),
  saveMessages: rows => ipcRenderer.invoke(IPC_CHANNELS.dbSaveMessages, rows),
  saveLogs: rows => ipcRenderer.invoke(IPC_CHANNELS.dbSaveLogs, rows),
  queryHistoryMessages: filter => ipcRenderer.invoke(IPC_CHANNELS.dbQueryHistoryMessages, filter),
  deleteHistoryMessage: id => ipcRenderer.invoke(IPC_CHANNELS.dbDeleteHistoryMessage, id),
  clearHistoryMessages: filter => ipcRenderer.invoke(IPC_CHANNELS.dbClearHistoryMessages, filter),
  queryHistoryLogs: filter => ipcRenderer.invoke(IPC_CHANNELS.dbQueryHistoryLogs, filter),
  deleteHistoryLog: id => ipcRenderer.invoke(IPC_CHANNELS.dbDeleteHistoryLog, id),
  clearHistoryLogs: filter => ipcRenderer.invoke(IPC_CHANNELS.dbClearHistoryLogs, filter),
  getPublishHistory: (connId, limit) => (
    ipcRenderer.invoke(IPC_CHANNELS.dbGetPublishHistory, connId, limit)
  ),
  savePublish: row => ipcRenderer.invoke(IPC_CHANNELS.dbSavePublish, row),
  getAllSettings: () => ipcRenderer.invoke(IPC_CHANNELS.dbGetAllSettings),
  saveSetting: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.dbSaveSetting, key, value),
  getStorageStats: () => ipcRenderer.invoke(IPC_CHANNELS.dbGetStorageStats),
  clearHistoryStorage: () => ipcRenderer.invoke(IPC_CHANNELS.dbClearHistoryStorage),
});

const mqtt = Object.freeze({
  connect: connection => ipcRenderer.invoke(IPC_CHANNELS.mqttConnect, connection),
  disconnect: connId => ipcRenderer.invoke(IPC_CHANNELS.mqttDisconnect, connId),
  subscribe: (connId, topic, qos) => (
    ipcRenderer.invoke(IPC_CHANNELS.mqttSubscribe, connId, topic, qos)
  ),
  unsubscribe: (connId, topic) => (
    ipcRenderer.invoke(IPC_CHANNELS.mqttUnsubscribe, connId, topic)
  ),
  publish: (connId, topic, payload, qos, retain) => (
    ipcRenderer.invoke(IPC_CHANNELS.mqttPublish, connId, topic, payload, qos, retain)
  ),
  onMessages: handler => addRemovableListener(IPC_CHANNELS.mqttMessages, handler),
  onStatus: handler => addRemovableListener(IPC_CHANNELS.mqttStatus, handler),
});

const clipboardApi = Object.freeze({
  readText: () => ipcRenderer.invoke(IPC_CHANNELS.clipboardReadText),
  writeText: value => ipcRenderer.invoke(IPC_CHANNELS.clipboardWriteText, String(value ?? '')),
});

const windowApi = Object.freeze({
  openHistory: (kind, connId) => (
    ipcRenderer.invoke(IPC_CHANNELS.windowOpenHistory, kind, connId)
  ),
  openExternal: url => ipcRenderer.invoke(IPC_CHANNELS.windowOpenExternal, url),
});

const lifecycle = Object.freeze({ onBeforeClose });
const update = Object.freeze({
  check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.updateState),
  download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
  cancel: () => ipcRenderer.invoke(IPC_CHANNELS.updateCancel),
  install: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
  onState: handler => addRemovableListener(IPC_CHANNELS.updateChanged, handler),
});

const api = Object.freeze({
  runtime: 'electron',
  db,
  mqtt,
  clipboard: clipboardApi,
  window: windowApi,
  lifecycle,
  update,
});

contextBridge.exposeInMainWorld('ineedMqtt', api);
