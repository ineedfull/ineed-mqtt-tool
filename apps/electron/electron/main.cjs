'use strict';

const { randomUUID } = require('node:crypto');
const { buildBrokerUrl } = require('@ineed-mqtt-tool/mqtt-contract/endpoint');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMessageBatcher } = require('./messageBatcher.cjs');
const { saveReceivedHistory } = require('./receivedHistory.cjs');
const { classifyMqttError, createMqttStatus } = require('./mqttDiagnostics.cjs');

const CLOSE_ACK_TIMEOUT_MS = 15_000;
const MQTT_CONNECT_TIMEOUT_MS = 12_000;
const MQTT_OPERATION_TIMEOUT_MS = 8_000;
const MQTT_END_TIMEOUT_MS = 3_000;
const MQTT_INBOUND_MAX_BYTES = 8_388_608;
const UPDATE_TIMEOUT_MS = 10_000;
const UPDATE_RESPONSE_MAX_BYTES = 65_536;
const IPC_MAX_BATCH_ITEMS = 1_000;
const IPC_MAX_ITEM_BYTES = 1_048_576;
const IPC_MAX_TOTAL_BYTES = 8_388_608;
// Full HEX/JSON text can be larger than the inbound MQTT byte payload.
const IPC_CLIPBOARD_MAX_BYTES = 33_554_432;
const UPDATE_ENDPOINT = 'https://mqtt.ineedfull.com/updates/latest.json';
const CURRENT_VERSION = require('../package.json').version;

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

const DB_HANDLERS = Object.freeze({
  [IPC_CHANNELS.dbGetConnections]: 'getConnections',
  [IPC_CHANNELS.dbSaveConnection]: 'saveConnection',
  [IPC_CHANNELS.dbDeleteConnection]: 'deleteConnection',
  [IPC_CHANNELS.dbGetMessageCounts]: 'getMessageCounts',
  [IPC_CHANNELS.dbGetSubscriptions]: 'getSubscriptions',
  [IPC_CHANNELS.dbAddSubscription]: 'addSubscription',
  [IPC_CHANNELS.dbRemoveSubscription]: 'removeSubscription',
  [IPC_CHANNELS.dbSaveMessages]: 'saveMessages',
  [IPC_CHANNELS.dbSaveLogs]: 'saveLogs',
  [IPC_CHANNELS.dbQueryHistoryMessages]: 'queryHistoryMessages',
  [IPC_CHANNELS.dbDeleteHistoryMessage]: 'deleteHistoryMessage',
  [IPC_CHANNELS.dbClearHistoryMessages]: 'clearHistoryMessages',
  [IPC_CHANNELS.dbQueryHistoryLogs]: 'queryHistoryLogs',
  [IPC_CHANNELS.dbDeleteHistoryLog]: 'deleteHistoryLog',
  [IPC_CHANNELS.dbClearHistoryLogs]: 'clearHistoryLogs',
  [IPC_CHANNELS.dbGetPublishHistory]: 'getPublishHistory',
  [IPC_CHANNELS.dbSavePublish]: 'savePublish',
  [IPC_CHANNELS.dbGetAllSettings]: 'getAllSettings',
  [IPC_CHANNELS.dbSaveSetting]: 'saveSetting',
  [IPC_CHANNELS.dbGetStorageStats]: 'getStorageStats',
  [IPC_CHANNELS.dbClearHistoryStorage]: 'clearHistoryStorage',
});

const INVOKE_CHANNELS = new Set([
  ...Object.keys(DB_HANDLERS),
  IPC_CHANNELS.mqttConnect,
  IPC_CHANNELS.mqttDisconnect,
  IPC_CHANNELS.mqttSubscribe,
  IPC_CHANNELS.mqttUnsubscribe,
  IPC_CHANNELS.mqttPublish,
  IPC_CHANNELS.clipboardReadText,
  IPC_CHANNELS.clipboardWriteText,
  IPC_CHANNELS.windowOpenHistory,
  IPC_CHANNELS.windowOpenExternal,
  IPC_CHANNELS.updateCheck,
  IPC_CHANNELS.updateState,
  IPC_CHANNELS.updateDownload,
  IPC_CHANNELS.updateCancel,
  IPC_CHANNELS.updateInstall,
]);
const HISTORY_CHANNELS = Object.freeze({
  messages: new Set([
    IPC_CHANNELS.clipboardReadText,
    IPC_CHANNELS.clipboardWriteText,
    IPC_CHANNELS.dbGetConnections,
    IPC_CHANNELS.dbGetAllSettings,
    IPC_CHANNELS.dbQueryHistoryMessages,
    IPC_CHANNELS.dbDeleteHistoryMessage,
    IPC_CHANNELS.dbClearHistoryMessages,
  ]),
  logs: new Set([
    IPC_CHANNELS.clipboardReadText,
    IPC_CHANNELS.clipboardWriteText,
    IPC_CHANNELS.dbGetConnections,
    IPC_CHANNELS.dbGetAllSettings,
    IPC_CHANNELS.dbQueryHistoryLogs,
    IPC_CHANNELS.dbDeleteHistoryLog,
    IPC_CHANNELS.dbClearHistoryLogs,
  ]),
});
const BATCH_CHANNELS = new Set([
  IPC_CHANNELS.dbSaveMessages,
  IPC_CHANNELS.dbSaveLogs,
]);

function errorMessage(error, fallback = 'Operation failed') {
  try {
    if (typeof error?.message === 'string' && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return String(error || fallback);
  } catch {
    return fallback;
  }
}

function nonblankString(value) {
  try {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

function normalizeQos(value) {
  if (value === 0 || value === 1 || value === 2) return value;
  if (value === '0' || value === '1' || value === '2') return Number(value);
  return null;
}

function ipcValueByteLength(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  if (
    Array.isArray(value)
    && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) return value.length;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('unsupported value');
    return Buffer.byteLength(serialized, 'utf8');
  } catch {
    throw new TypeError('IPC payload must be serializable');
  }
}

function validateIpcPayload(channel, args, {
  maxBatchItems = IPC_MAX_BATCH_ITEMS,
  maxItemBytes = IPC_MAX_ITEM_BYTES,
  maxTotalBytes = IPC_MAX_TOTAL_BYTES,
} = {}) {
  if (!Array.isArray(args)) throw new TypeError('IPC arguments must be an array');
  const values = [];
  if (BATCH_CHANNELS.has(channel) && Array.isArray(args[0])) {
    if (args[0].length > maxBatchItems) throw new RangeError('IPC batch item limit exceeded');
    values.push(...args[0], ...args.slice(1));
  } else {
    values.push(...args);
  }
  let totalBytes = 0;
  for (const value of values) {
    const bytes = ipcValueByteLength(value);
    if (bytes > maxItemBytes) throw new RangeError('IPC payload item byte limit exceeded');
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) throw new RangeError('IPC payload total byte limit exceeded');
  }
  return totalBytes;
}

function createWindowManager({
  BrowserWindow,
  dirname = __dirname,
  devServerUrl = '',
  enableDevTools = false,
  onNavigationError = error => console.error('[Electron] renderer navigation failed:', errorMessage(error)),
} = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required');
  const preload = path.join(dirname, 'preload.cjs');
  const rendererEntry = path.join(dirname, '..', 'dist', 'index.html');
  const windows = new Set();
  const historyWindows = new Map();
  const windowRecords = new Map();
  let mainWindow = null;

  function browserWindowOptions(options) {
    return {
      ...options,
      icon: path.join(dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    };
  }

  function secureWebContents(win) {
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on?.('will-navigate', event => event.preventDefault());
    win.webContents.on?.('will-attach-webview', event => event.preventDefault());
  }

  function track(win, role, kind = null) {
    windows.add(win);
    secureWebContents(win);
    const record = {
      closed: false,
      committedUrl: null,
      kind,
      navigationTail: null,
      pendingUrls: new Map(),
      role,
      window: win,
    };
    const contents = win.webContents;
    windowRecords.set(contents, record);
    win.on?.('closed', () => {
      record.closed = true;
      record.pendingUrls.clear();
      windows.delete(win);
      windowRecords.delete(contents);
      if (mainWindow === win) mainWindow = null;
    });
    return win;
  }

  function loadRenderer(win, query = null) {
    if (devServerUrl) {
      const url = new URL(devServerUrl);
      if (query) {
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      }
      return win.loadURL(url.toString());
    }
    if (query) return win.loadFile(rendererEntry, { query });
    return win.loadFile(rendererEntry);
  }

  function rendererUrl(query = null) {
    const url = devServerUrl ? new URL(devServerUrl) : pathToFileURL(rendererEntry);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function navigateRenderer(win, query = null) {
    const record = windowRecords.get(win.webContents);
    if (!record || record.closed) return;
    const targetUrl = rendererUrl(query);
    record.pendingUrls.set(targetUrl, (record.pendingUrls.get(targetUrl) || 0) + 1);

    const releaseTarget = () => {
      const remaining = (record.pendingUrls.get(targetUrl) || 1) - 1;
      if (remaining > 0) record.pendingUrls.set(targetUrl, remaining);
      else record.pendingUrls.delete(targetUrl);
    };
    const reportNavigationError = error => {
      try { onNavigationError(error); } catch { /* Keep navigation failures contained. */ }
    };
    const navigate = () => {
      if (record.closed || windowRecords.get(win.webContents) !== record || win.isDestroyed()) {
        releaseTarget();
        return Promise.resolve();
      }
      let navigation;
      try {
        navigation = loadRenderer(win, query);
      } catch (error) {
        reportNavigationError(error);
        releaseTarget();
        return Promise.resolve();
      }
      return Promise.resolve(navigation)
        .then(() => {
          if (!record.closed && windowRecords.get(win.webContents) === record && !win.isDestroyed()) {
            record.committedUrl = targetUrl;
          }
        })
        .catch(reportNavigationError)
        .finally(releaseTarget);
    };

    const navigation = record.navigationTail
      ? record.navigationTail.then(navigate)
      : navigate();
    record.navigationTail = navigation;
    navigation.then(() => {
      if (record.navigationTail === navigation) record.navigationTail = null;
    });
  }

  function recordAllowsUrl(record, url) {
    return url === record.committedUrl || record.pendingUrls.has(url);
  }

  function createMainWindow(beforeLoad) {
    const win = track(new BrowserWindow(browserWindowOptions({
      width: 1360,
      height: 860,
      minWidth: 1120,
      minHeight: 720,
      title: 'iNeed MQTT Tool',
      autoHideMenuBar: true,
      backgroundColor: '#f3f4f6',
    })), 'main');
    mainWindow = win;
    beforeLoad?.(win);
    navigateRenderer(win);
    if (devServerUrl && enableDevTools) win.webContents.openDevTools();
    return win;
  }

  function createHistoryWindow(kind, connId, beforeLoad) {
    if (kind !== 'messages' && kind !== 'logs') {
      throw new TypeError('history kind must be messages or logs');
    }
    const normalizedConnId = nonblankString(connId);
    if (normalizedConnId === null) throw new TypeError('connection id must be a nonblank string');
    const existing = historyWindows.get(kind);
    if (existing && !existing.isDestroyed()) {
      navigateRenderer(existing, { history: kind, connId: normalizedConnId });
      existing.focus();
      return existing;
    }
    historyWindows.delete(kind);
    const win = track(new BrowserWindow(browserWindowOptions({
      width: 1180,
      height: 760,
      minWidth: 900,
      minHeight: 600,
      title: kind === 'logs' ? '历史日志' : '历史消息',
      backgroundColor: '#f3f4f6',
    })), 'history', kind);
    historyWindows.set(kind, win);
    win.on?.('closed', () => {
      if (historyWindows.get(kind) === win) historyWindows.delete(kind);
    });
    beforeLoad?.(win);
    navigateRenderer(win, { history: kind, connId: normalizedConnId });
    return win;
  }

  return Object.freeze({
    authorizeIpc(event, channel) {
      try {
        const record = windowRecords.get(event?.sender);
        if (
          !record
          || record.window.isDestroyed()
          || event.senderFrame !== event.sender.mainFrame
          || !recordAllowsUrl(record, event.senderFrame.url)
          || !INVOKE_CHANNELS.has(channel)
        ) return false;
        if (record.role === 'main') return true;
        return HISTORY_CHANNELS[record.kind]?.has(channel) === true;
      } catch {
        return false;
      }
    },
    createMainWindow,
    createHistoryWindow,
    getMainWindow: () => mainWindow,
    getWindows: () => [...windows],
  });
}

function installCloseHandshake({
  window,
  ipcMain,
  timeoutMs = CLOSE_ACK_TIMEOUT_MS,
  createRequestId = randomUUID,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  finalize,
  isBlocked = () => false,
} = {}) {
  if (!window?.webContents || typeof ipcMain?.on !== 'function') {
    throw new TypeError('window and ipcMain are required');
  }
  if (typeof finalize !== 'function') throw new TypeError('finalize must be a function');
  let started = false;
  let disposed = false;
  let settled = false;
  let timer = null;
  let requestId = null;

  function removeAckListener() {
    ipcMain.removeListener(IPC_CHANNELS.lifecycleBeforeCloseAck, onAck);
  }

  function cleanupAck() {
    removeAckListener();
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function cleanup() {
    cleanupAck();
    window.removeListener?.('close', onClose);
  }

  function settle(ok, timedOut) {
    if (settled || disposed) return;
    settled = true;
    cleanupAck();
    Promise.resolve(finalize({ requestId, ok, timedOut })).catch(error => {
      console.error('[Electron] close finalization failed:', errorMessage(error));
    }).finally(() => {
      if (!disposed) {
        disposed = true;
        cleanup();
      }
    });
  }

  function onAck(event, payload) {
    let acknowledgedRequestId;
    let acknowledgedOk;
    try {
      acknowledgedRequestId = payload?.requestId;
      acknowledgedOk = payload?.ok;
    } catch {
      return;
    }
    if (
      !started
      || settled
      || event?.sender !== window.webContents
      || acknowledgedRequestId !== requestId
      || typeof acknowledgedOk !== 'boolean'
    ) return;
    settle(acknowledgedOk, false);
  }

  function onClose(event) {
    if (disposed) return;
    event.preventDefault();
    if (isBlocked()) return;
    if (started) return;
    started = true;
    requestId = nonblankString(createRequestId());
    if (requestId === null) requestId = randomUUID();
    ipcMain.on(IPC_CHANNELS.lifecycleBeforeCloseAck, onAck);
    timer = setTimer(() => settle(false, true), timeoutMs);
    window.webContents.send(IPC_CHANNELS.lifecycleBeforeClose, { requestId });
  }

  window.on('close', onClose);
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  });
}

function createMqttCoordinator({
  mqtt,
  db,
  send,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  scheduleBatch = (callback, delay) => setTimeout(callback, delay),
  clearBatch = timer => clearTimeout(timer),
} = {}) {
  if (typeof mqtt?.connect !== 'function') throw new TypeError('mqtt.connect is required');
  if (typeof send !== 'function') throw new TypeError('send is required');
  const clients = new Map();
  let nextGeneration = 1;
  let historyError = null;
  const batcher = createMessageBatcher({
    flushMs: 200,
    maxBatchSize: 200,
    emitBatch: rows => {
      if (db) {
        try { saveReceivedHistory(db, rows); }
        catch (error) {
          historyError = error;
          for (const connId of new Set(rows.map(row => row.connId))) {
            const handle = clients.get(connId);
            if (handle) void stopHandle(connId, handle, { force: true, reason: 'history persistence failed', emitStatus: false });
            sendStatus(connId, 'error', { source: 'storage', code: 'HISTORY_WRITE_FAILED', reason: errorMessage(error, 'History write failed') });
          }
          throw error;
        }
      }
      send(IPC_CHANNELS.mqttMessages, rows);
    },
    schedule: scheduleBatch,
    clear: clearBatch,
  });

  function flushMessages() {
    let result = false;
    // Delivery retries may leave another batch behind them. Stop reception first
    // when closing, then commit every remaining batch before deleting/closing DB.
    while (batcher.size > 0) {
      result = batcher.flush();
      if (historyError) throw historyError;
    }
    if (historyError) throw historyError;
    return result;
  }

  function sendStatus(connId, status, details = {}) {
    try {
      send(IPC_CHANNELS.mqttStatus, createMqttStatus(connId, status, details));
      return null;
    } catch (error) {
      return error;
    }
  }

  function validateConnection(connection) {
    if (connection === null || typeof connection !== 'object') return 'connection is required';
    if (nonblankString(connection.id) === null) return 'connection id is required';
    if (nonblankString(connection.host) === null) return 'host is required';
    const port = Number(connection.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'port must be between 1 and 65535';
    const protocol = String(connection.protocol || 'mqtt').replace(/:\/\/$/, '');
    if (!['mqtt', 'mqtts', 'ws', 'wss'].includes(protocol)) return 'unsupported MQTT protocol';
    return null;
  }

  function activeHandle(connId) {
    const id = nonblankString(connId);
    return id === null ? null : clients.get(id) || null;
  }

  function endClient(handle, force) {
    if (handle.endPromise) return handle.endPromise;
    let resolveEnd;
    handle.endPromise = new Promise(resolve => { resolveEnd = resolve; });
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { clearTimer(timer); } catch { /* End settlement must continue. */ }
      resolveEnd();
    };
    try { timer = setTimer(finish, MQTT_END_TIMEOUT_MS); } catch { finish(); }
    try {
      handle.client.end(force, finish);
    } catch {
      finish();
    }
    return handle.endPromise;
  }

  function stopHandle(connId, handle, { force, reason, emitStatus }) {
    if (handle.stopPromise) return handle.stopPromise;
    let resolveStop;
    handle.stopPromise = new Promise(resolve => { resolveStop = resolve; });
    if (clients.get(connId) === handle) clients.delete(connId);
    handle.stopped = true;
    try { handle.settle?.({ ok: false, error: reason }); } catch { /* Keep stopping. */ }
    try { handle.cleanupListeners?.(); } catch { /* Keep stopping. */ }
    Promise.resolve(endClient(handle, force)).then(resolveStop, resolveStop);
    if (emitStatus) {
      sendStatus(connId, 'disconnected', {
        source: 'user',
        code: handle.connectedOnce ? 'USER_DISCONNECTED' : 'USER_CANCELLED',
        reason: handle.connectedOnce ? 'connection closed by user' : 'connection cancelled by user',
        attempt: handle.retryAttempt,
        disconnectedAt: handle.outageStartedAt,
      });
    }
    return handle.stopPromise;
  }

  async function connect(connection) {
    try {
      const validationError = validateConnection(connection);
      if (validationError) return { ok: false, error: validationError };
      const url = buildBrokerUrl(connection);
      const connId = connection.id;
      const previous = clients.get(connId);
      if (previous) {
        void stopHandle(connId, previous, {
          force: true,
          reason: 'connection replaced',
          emitStatus: false,
        });
      }
      const configuredClientId = connection.clientId ?? connection.client_id;
      const configuredCleanSession = connection.cleanSession ?? connection.clean_session;
      const client = mqtt.connect(url, {
        // MQTT.js rebuilds WS URLs from a hostname without IPv6 brackets.
        // Preserve the validated endpoint and keep query parameters out of client options.
        ...(url.startsWith('ws') ? { transformWsUrl: () => url, query: {} } : {}),
        clientId: nonblankString(configuredClientId) || `ineed-${now()}`,
        username: nonblankString(connection.username) || undefined,
        password: typeof connection.password === 'string' && connection.password !== ''
          ? connection.password
          : undefined,
        keepalive: Number(connection.keepalive) || 60,
        clean: configuredCleanSession !== false && configuredCleanSession !== 0,
        connectTimeout: 10_000,
        reconnectPeriod: connection.autoReconnect === false ? 0 : 1_000,
        resubscribe: false,
      });
      const handle = {
        client,
        generation: nextGeneration++,
        stopped: false,
        connectedOnce: false,
        outageStartedAt: null,
        retryAttempt: 0,
        lastDiagnostic: null,
        endPromise: null,
        listeners: [],
        settle: null,
        stopPromise: null,
      };
      clients.set(connId, handle);
      const isCurrent = () => clients.get(connId) === handle && !handle.stopped;
      const listen = (eventName, listener) => {
        const containedListener = (...args) => {
          try {
            listener(...args);
          } catch (error) {
            if (!isCurrent()) return;
            const diagnostic = classifyMqttError(error);
            void stopHandle(connId, handle, {
              force: true,
              reason: errorMessage(error, 'MQTT event failed'),
              emitStatus: false,
            });
            sendStatus(connId, 'error', diagnostic);
          }
        };
        client.on(eventName, containedListener);
        handle.listeners.push([eventName, containedListener]);
      };
      handle.cleanupListeners = () => {
        for (const [eventName, listener] of handle.listeners.splice(0)) {
          client.removeListener?.(eventName, listener);
        }
        // EventEmitter treats a late error with no listener as an uncaught exception.
        if (typeof client.listenerCount !== 'function' || client.listenerCount('error') === 0) {
          client.on('error', () => {});
        }
      };
      const connectingDeliveryError = sendStatus(
        connId, 'connecting', { source: 'client', code: 'CONNECTING' },
      );
      if (connectingDeliveryError) {
        void stopHandle(connId, handle, {
          force: true,
          reason: errorMessage(connectingDeliveryError, 'MQTT status delivery failed'),
          emitStatus: false,
        });
        return {
          ok: false,
          error: errorMessage(connectingDeliveryError, 'MQTT status delivery failed'),
        };
      }

      return await new Promise(resolve => {
        let settled = false;
        const settle = result => {
          if (settled) return;
          settled = true;
          clearTimer(connectTimer);
          resolve(result);
        };
        handle.settle = settle;
        const connectTimer = setTimer(() => {
          if (isCurrent()) {
            const diagnostic = classifyMqttError('MQTT connection timeout');
            void stopHandle(connId, handle, {
              force: true,
              reason: 'timeout',
              emitStatus: false,
            });
            sendStatus(connId, 'error', diagnostic);
          }
          settle({ ok: false, error: 'timeout' });
        }, MQTT_CONNECT_TIMEOUT_MS);

        const terminateWithError = (error, diagnostic = classifyMqttError(error)) => {
          if (!isCurrent()) return;
          handle.lastDiagnostic = diagnostic;
          void stopHandle(connId, handle, {
            force: true,
            reason: errorMessage(error, 'MQTT connection failed'),
            emitStatus: false,
          });
          sendStatus(connId, 'error', diagnostic);
        };
        const sendActiveStatus = (status, details) => {
          const deliveryError = sendStatus(connId, status, details);
          if (!deliveryError) return true;
          if (isCurrent()) {
            void stopHandle(connId, handle, {
              force: true,
              reason: errorMessage(deliveryError, 'MQTT status delivery failed'),
              emitStatus: false,
            });
          }
          return false;
        };

        listen('connect', () => {
          if (!isCurrent()) return;
          const reconnected = handle.connectedOnce;
          if (!sendActiveStatus('connected', {
            reconnected,
            attempt: handle.retryAttempt,
            disconnectedAt: handle.outageStartedAt,
          })) return;
          handle.connectedOnce = true;
          handle.outageStartedAt = null;
          handle.retryAttempt = 0;
          handle.lastDiagnostic = null;
          settle({ ok: true });
        });
        listen('message', (topic, payload, packet = {}) => {
          if (!isCurrent()) return;
          const payloadBytes = typeof payload === 'string'
            ? Buffer.byteLength(payload, 'utf8')
            : Number(payload?.byteLength ?? payload?.length);
          if (Number.isFinite(payloadBytes) && payloadBytes > MQTT_INBOUND_MAX_BYTES) {
            sendActiveStatus('error', {
              source: 'client',
              code: 'PAYLOAD_TOO_LARGE',
              reason: `Inbound MQTT payload exceeds ${MQTT_INBOUND_MAX_BYTES} bytes`,
            });
            return;
          }
          const bytes = Buffer.from(payload);
          batcher.enqueue({
            connId,
            topic: String(topic),
            payload: Array.from(bytes),
            payloadText: bytes.toString('utf8'),
            qos: normalizeQos(packet.qos) ?? 0,
            retained: Boolean(packet.retain),
            timestamp: now(),
          });
        });
        listen('reconnect', () => {
          if (!isCurrent() || !handle.connectedOnce) return;
          if (handle.outageStartedAt === null) handle.outageStartedAt = now();
          handle.retryAttempt += 1;
          sendActiveStatus('reconnecting', {
            ...(handle.lastDiagnostic || classifyMqttError('connection lost')),
            attempt: handle.retryAttempt,
            nextDelayMs: 1_000,
            disconnectedAt: handle.outageStartedAt,
          });
        });
        for (const eventName of ['offline', 'close']) {
          listen(eventName, () => {
            if (!isCurrent() || !handle.connectedOnce) return;
            const diagnostic = classifyMqttError(eventName === 'offline' ? 'offline' : 'connection closed');
            handle.lastDiagnostic = diagnostic;
            if (connection.autoReconnect === false) {
              terminateWithError(diagnostic.reason, diagnostic);
            } else {
              if (handle.outageStartedAt === null) handle.outageStartedAt = now();
              sendActiveStatus('reconnecting', {
                ...diagnostic,
                attempt: handle.retryAttempt,
                disconnectedAt: handle.outageStartedAt,
              });
            }
          });
        }
        listen('error', error => {
          if (!isCurrent()) return;
          const diagnostic = classifyMqttError(error);
          handle.lastDiagnostic = diagnostic;
          if (
            !handle.connectedOnce
            && (
              connection.autoReconnect === false
              ||
              ['broker', 'client'].includes(diagnostic.source)
            )
          ) {
            terminateWithError(error, diagnostic);
          } else if (handle.connectedOnce && connection.autoReconnect !== false) {
            if (handle.outageStartedAt === null) handle.outageStartedAt = now();
            sendActiveStatus('reconnecting', {
              ...diagnostic,
              attempt: handle.retryAttempt,
              disconnectedAt: handle.outageStartedAt,
            });
          } else if (handle.connectedOnce) {
            terminateWithError(error, diagnostic);
          }
        });
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async function disconnect(connId, { force = false } = {}) {
    const id = nonblankString(connId);
    if (id === null) return { ok: false, error: 'connection id is required' };
    const handle = clients.get(id);
    if (handle) {
      await stopHandle(id, handle, { force: Boolean(force), reason: 'cancelled', emitStatus: true });
    } else {
      sendStatus(id, 'disconnected', { source: 'user', code: 'USER_CANCELLED' });
    }
    if (db) flushMessages();
    return { ok: true };
  }

  function callbackOperation(connId, topic, operation, timeoutError) {
    const id = nonblankString(connId);
    if (id === null) return Promise.resolve({ ok: false, error: 'connection id is required' });
    const normalizedTopic = nonblankString(topic);
    if (normalizedTopic === null) return Promise.resolve({ ok: false, error: 'topic is required' });
    const handle = activeHandle(id);
    if (!handle) return Promise.resolve({ ok: false, error: 'not connected' });
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (clients.get(id) !== handle) {
          resolve({
            ok: false,
            error: clients.has(id) ? 'connection replaced' : 'not connected',
          });
        } else {
          resolve(result);
        }
      };
      const timer = setTimer(() => finish({ ok: false, error: timeoutError }), MQTT_OPERATION_TIMEOUT_MS);
      try {
        operation(handle.client, normalizedTopic, finish);
      } catch (error) {
        finish({ ok: false, error: errorMessage(error) });
      }
    });
  }

  function subscribe(connId, topic, qos) {
    const normalizedQos = normalizeQos(qos);
    if (normalizedQos === null) return Promise.resolve({ ok: false, error: 'qos must be 0, 1, or 2' });
    return callbackOperation(connId, topic, (client, value, finish) => {
      client.subscribe(value, { qos: normalizedQos }, (error, granted) => {
        if (error) finish({ ok: false, error: errorMessage(error) });
        else finish({ ok: true, granted: Array.isArray(granted) ? granted : [] });
      });
    }, 'subscribe timeout');
  }

  function unsubscribe(connId, topic) {
    return callbackOperation(connId, topic, (client, value, finish) => {
      client.unsubscribe(value, error => {
        finish(error ? { ok: false, error: errorMessage(error) } : { ok: true });
      });
    }, 'unsubscribe timeout');
  }

  function publish(connId, topic, payload, qos, retain) {
    const publishTopic = nonblankString(topic);
    if (publishTopic === null) return Promise.resolve({ ok: false, error: 'topic is required' });
    // MQTT topic names cannot use subscription wildcards. Reject before the
    // client reports a QoS 0 send as successful and the broker closes its socket.
    if (/[+#]|\p{Cc}/u.test(publishTopic) || Buffer.byteLength(publishTopic, 'utf8') > 65_535) {
      return Promise.resolve({ ok: false, error: 'invalid MQTT publish topic' });
    }
    const normalizedQos = normalizeQos(qos);
    if (normalizedQos === null) return Promise.resolve({ ok: false, error: 'qos must be 0, 1, or 2' });
    let normalizedPayload;
    if (typeof payload === 'string') {
      normalizedPayload = payload;
    } else if (
      Array.isArray(payload)
      && payload.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      normalizedPayload = Buffer.from(payload);
    } else {
      return Promise.resolve({ ok: false, error: 'payload must be a string or byte array' });
    }
    return callbackOperation(connId, topic, (client, value, finish) => {
      client.publish(value, normalizedPayload, { qos: normalizedQos, retain: Boolean(retain) }, error => {
        finish(error ? { ok: false, error: errorMessage(error) } : { ok: true });
      });
    }, 'publish timeout');
  }

  async function disconnectAll({ force = false, strict = false } = {}) {
    const pending = [...clients.entries()].map(([connId, handle]) => (
      stopHandle(connId, handle, { force: Boolean(force), reason: 'shutdown', emitStatus: false })
    ));
    const results = await Promise.allSettled(pending);
    if (strict && results.some(result => result.status === 'rejected')) throw new Error('MQTT disconnect failed');
    if (db && !historyError) flushMessages();
    if (strict && historyError) throw historyError;
  }

  return Object.freeze({
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    publish,
    disconnectAll,
    flush: flushMessages,
    dispose: () => batcher.dispose(),
    get size() { return clients.size; },
  });
}

function isSafeExternalUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hostname !== '';
  } catch {
    return false;
  }
}

function createSmokeExitGate({ beforeExit = () => {}, enabled, exitProcess = () => {} } = {}) {
  let cleanupComplete = false;
  let exited = false;
  const exit = enabled ? exitProcess : () => {};
  const destroyedWindows = new Map();

  function destroyWindow(role, window) {
    if (window && !window.isDestroyed()) window.destroy();
    if (window?.isDestroyed() !== true) throw new Error(`${role} window did not close`);
    destroyedWindows.set(role, window);
  }

  function maybeExit() {
    if (
      !enabled
      || exited
      || !cleanupComplete
      || destroyedWindows.get('main')?.isDestroyed() !== true
      || destroyedWindows.get('history')?.isDestroyed() !== true
    ) return;
    exited = true;
    exit((beforeExit(), 0));
  }

  return Object.freeze({
    markCleanupComplete() {
      cleanupComplete = true;
      maybeExit();
    },
    markWindowDestroyed(role, window) {
      if ((role === 'main' || role === 'history') && window?.isDestroyed() === true) {
        destroyedWindows.set(role, window);
      }
      maybeExit();
    },
    destroyFinalWindowAndExit(role, window) {
      if (
        !enabled
        || exited
        || !cleanupComplete
        || role !== 'main'
        || destroyedWindows.get('history')?.isDestroyed() !== true
      ) return false;
      exited = true;
      exit((destroyWindow(role, window), beforeExit(), 0));
      return true;
    },
  });
}

function readSmokeHistoryKind(env, smokeTest) {
  if (!smokeTest) return null;
  const kind = nonblankString(env?.INEED_SMOKE_HISTORY);
  if (kind !== 'messages' && kind !== 'logs') {
    throw new TypeError('INEED_SMOKE_HISTORY must be messages or logs');
  }
  return kind;
}

function writeSmokeMarker({
  marker = 'mqtt-tool-history-closed',
  onError = () => {},
  write = fs.writeSync,
} = {}) {
  try {
    write(1, `${marker}\n`);
    return true;
  } catch (error) {
    try { onError(error); } catch { /* Marker failure reporting must stay contained. */ }
    return false;
  }
}

async function checkForUpdates({
  fetch,
  endpoint = UPDATE_ENDPOINT,
  timeoutMs = UPDATE_TIMEOUT_MS,
  platform = process.platform,
  arch = process.arch,
  appImage = Boolean(process.env.APPIMAGE),
  currentVersion = CURRENT_VERSION,
} = {}) {
  if (typeof fetch !== 'function') throw new TypeError('Update fetch is unavailable');
  if (!isSafeExternalUrl(endpoint)) throw new TypeError('Invalid update endpoint');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Update timeout must be a positive finite number');
  }
  const platformName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform];
  if (!platformName || !['arm64', 'x64'].includes(arch) || (platformName !== 'macos' && arch !== 'x64')) {
    throw new TypeError('Unsupported update platform');
  }
  const format = platformName === 'macos' ? 'dmg' : platformName === 'windows' ? 'nsis' : appImage ? 'appimage' : 'deb';
  const versionParts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(currentVersion);
  if (!versionParts) throw new TypeError('Invalid current update version');
  const [, major, minor, patch] = versionParts.map(Number);
  const currentNumberVersion = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || currentNumberVersion > 2_147_483_647) {
    throw new TypeError('Current update version exceeds numeric version range');
  }
  const controller = new AbortController();
  const timeoutError = new Error('Update check timed out');
  let timedOut = false;
  let response = null;
  let responseBody = null;
  let reader = null;
  let bodyComplete = false;
  let cancellationStarted = false;
  let failure = null;
  let rejectOnTimeout;
  const timeout = new Promise((resolve, reject) => {
    void resolve;
    rejectOnTimeout = reject;
  });
  const cancelResponseBody = reason => {
    if (cancellationStarted || bodyComplete) return;
    cancellationStarted = true;
    try {
      if (!reader && typeof responseBody?.cancel !== 'function' && typeof responseBody?.getReader === 'function') {
        reader = responseBody.getReader();
      }
      const cancellation = typeof reader?.cancel === 'function'
        ? reader.cancel(reason)
        : responseBody?.cancel?.(reason);
      Promise.resolve(cancellation).catch(() => {});
    } catch { /* Reader cancellation is best-effort. */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancelResponseBody(timeoutError);
    controller.abort(timeoutError);
    rejectOnTimeout(timeoutError);
  }, timeoutMs);
  try {
    response = await Promise.race([
      fetch(endpoint, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
      }),
      timeout,
    ]);
    responseBody = response?.body ?? null;
    if (!response?.ok) throw new Error(`Update check failed (${response?.status || 'unknown'})`);

    let contentLength = null;
    const declaredLength = response.headers?.get?.('content-length');
    if (declaredLength !== null && declaredLength !== undefined) {
      if (typeof declaredLength !== 'string' || !/^\d+$/.test(declaredLength)) {
        throw new TypeError('Invalid update Content-Length');
      }
      contentLength = Number(declaredLength);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new TypeError('Invalid update Content-Length');
      }
      if (contentLength > UPDATE_RESPONSE_MAX_BYTES) {
        throw new RangeError('Update response is too large');
      }
    }

    let text;
    if (typeof responseBody?.getReader === 'function') {
      reader = responseBody.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let receivedBytes = 0;
      text = '';
      while (true) {
        const chunk = await Promise.race([reader.read(), timeout]);
        if (chunk?.done) break;
        if (!(chunk?.value instanceof Uint8Array)) {
          throw new TypeError('Invalid update response stream');
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > UPDATE_RESPONSE_MAX_BYTES) {
          const sizeError = new RangeError('Update response is too large');
          cancelResponseBody(sizeError);
          controller.abort(sizeError);
          throw sizeError;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      bodyComplete = true;
      text += decoder.decode();
    } else {
      if (contentLength === null) {
        throw new TypeError('Update Content-Length is required without a response stream');
      }
      if (typeof response.text !== 'function') throw new TypeError('Invalid update response text');
      text = await Promise.race([response.text(), timeout]);
      bodyComplete = true;
      if (typeof text !== 'string') throw new TypeError('Invalid update response text');
      if (Buffer.byteLength(text, 'utf8') > UPDATE_RESPONSE_MAX_BYTES) {
        throw new RangeError('Update response is too large');
      }
    }
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new TypeError('Invalid update response');
    }
    if (body.schemaVersion !== 1) throw new TypeError('Invalid update schemaVersion');
    if (body.appId !== 'ineed-mqtt-tool') throw new TypeError('Invalid update appId');
    if (body.releases === null || typeof body.releases !== 'object' || Array.isArray(body.releases)) {
      throw new TypeError('Invalid update releases');
    }
    const release = body.releases[`electron-${platformName}-${arch}-${format}`];
    if (release === undefined) {
      return { available: false, version: currentVersion, url: '', force: false, description: '' };
    }
    if (release === null || typeof release !== 'object' || Array.isArray(release)) {
      throw new TypeError('Invalid update release');
    }
    if (typeof release.version !== 'string') throw new TypeError('Invalid update version');
    const releaseParts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(release.version);
    if (!releaseParts || release.version.length > 128) throw new TypeError('Invalid update version');
    const [, releaseMajor, releaseMinor, releasePatch] = releaseParts.map(Number);
    const releaseNumberVersion = releaseMajor * 1_000_000 + releaseMinor * 1_000 + releasePatch;
    if (releaseMinor > 999 || releasePatch > 999 || releaseNumberVersion > 2_147_483_647) {
      throw new TypeError('Invalid update version');
    }
    if (!isSafeExternalUrl(release.url)) throw new TypeError('Invalid update url');
    if (release.force != null && typeof release.force !== 'boolean') throw new TypeError('Invalid update force');
    if (release.description != null && typeof release.description !== 'string') {
      throw new TypeError('Invalid update description');
    }
    if (releaseNumberVersion <= currentNumberVersion) {
      return { available: false, version: currentVersion, url: '', force: false, description: '' };
    }
    return {
      available: true,
      version: release.version,
      url: new URL(release.url).toString(),
      force: release.force ?? false,
      description: release.description || '',
    };
  } catch (error) {
    failure = timedOut ? timeoutError : error;
    throw failure;
  } finally {
    clearTimeout(timer);
    if (response !== null && !bodyComplete) {
      cancelResponseBody(failure || new Error('Update response was not consumed'));
      if (!controller.signal.aborted) controller.abort(failure);
    }
  }
}

function registerInvokeHandlers({
  ipcMain,
  clipboard,
  db,
  mqttCoordinator,
  windowManager,
  shell,
  net,
  getUpdater = () => null,
  onInvokeSettled = () => {},
} = {}) {
  if (typeof ipcMain?.handle !== 'function') throw new TypeError('ipcMain is required');
  const registered = [];
  function handle(channel, handler, payloadLimits) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!windowManager.authorizeIpc(event, channel)) {
          throw new Error('IPC sender is not authorized');
        }
        validateIpcPayload(channel, args, payloadLimits);
        return await handler(event, ...args);
      } finally {
        try { onInvokeSettled(event, channel); } catch { /* Keep observation contained. */ }
      }
    });
    registered.push(channel);
  }

  for (const [channel, method] of Object.entries(DB_HANDLERS)) {
    if (typeof db?.[method] !== 'function') throw new TypeError(`database method ${method} is required`);
    if (channel === IPC_CHANNELS.dbDeleteConnection) {
      handle(channel, async (_event, id) => {
        await mqttCoordinator.disconnect(id);
        return db[method](id);
      });
    } else {
      handle(channel, (_event, ...args) => db[method](...args));
    }
  }
  for (const [channel, method] of [
    [IPC_CHANNELS.mqttConnect, 'connect'],
    [IPC_CHANNELS.mqttDisconnect, 'disconnect'],
    [IPC_CHANNELS.mqttSubscribe, 'subscribe'],
    [IPC_CHANNELS.mqttUnsubscribe, 'unsubscribe'],
    [IPC_CHANNELS.mqttPublish, 'publish'],
  ]) {
    handle(channel, (_event, ...args) => {
      if (method !== 'disconnect' && ['preparing', 'installing'].includes(getUpdater()?.getState().phase)) {
        throw new Error('正在准备安装更新');
      }
      return mqttCoordinator[method](...args);
    });
  }
  handle(IPC_CHANNELS.clipboardReadText, () => clipboard.readText());
  handle(IPC_CHANNELS.clipboardWriteText, (_event, value) => {
    if (typeof value !== 'string') throw new TypeError('Clipboard text must be a string');
    clipboard.writeText(value);
    return { ok: true };
  }, { maxItemBytes: IPC_CLIPBOARD_MAX_BYTES, maxTotalBytes: IPC_CLIPBOARD_MAX_BYTES });
  handle(IPC_CHANNELS.windowOpenHistory, (_event, kind, connId) => {
    windowManager.createHistoryWindow(kind, connId);
    return { ok: true };
  });
  handle(IPC_CHANNELS.windowOpenExternal, async (_event, value) => {
    if (!isSafeExternalUrl(value)) return { ok: false, error: 'Only absolute credential-free HTTPS URLs are allowed' };
    await shell.openExternal(value);
    return { ok: true };
  });
  handle(IPC_CHANNELS.updateCheck, () => getUpdater()?.check() ?? checkForUpdates({ fetch: net.fetch.bind(net) }));
  handle(IPC_CHANNELS.updateState, () => getUpdater()?.getState() ?? { phase: 'idle', supported: false, error: '' });
  for (const [channel, method] of [[IPC_CHANNELS.updateDownload, 'download'], [IPC_CHANNELS.updateCancel, 'cancel'], [IPC_CHANNELS.updateInstall, 'install']]) {
    handle(channel, () => {
      const updater = getUpdater();
      if (!updater) throw new Error('尚未配置应用内更新签名');
      return updater[method]();
    });
  }

  return () => {
    for (const channel of registered) ipcMain.removeHandler?.(channel);
  };
}

function createShutdownController({
  mqttCoordinator,
  db,
  removeHandlers,
  getCloseController,
  app,
  onError = () => {},
} = {}) {
  let inFlight = null;
  let running = false;

  function shutdown(window) {
    if (inFlight !== null) return inFlight;
    running = true;
    inFlight = (async () => {
      const errors = [];
      async function attempt(phase, operation) {
        try {
          await operation();
        } catch (error) {
          errors.push({ phase, error });
          try { onError(phase, error); } catch { /* Keep shutdown reporting contained. */ }
        }
      }
      try {
        await attempt('disconnect', () => mqttCoordinator.disconnectAll());
        await attempt('flush', () => mqttCoordinator.flush());
        await attempt('database', () => db.closeDatabase());
      } finally {
        await attempt('mqtt-dispose', () => mqttCoordinator.dispose());
        await attempt('handlers', () => removeHandlers());
        await attempt('close-controller', () => getCloseController()?.dispose());
        await attempt('destroy', () => {
          if (window && !window.isDestroyed()) window.destroy();
        });
        await attempt('quit', () => app.quit());
        running = false;
      }
      return { ok: errors.length === 0, errors };
    })();
    return inFlight;
  }

  return Object.freeze({
    shutdown,
    get running() { return running; },
    get started() { return inFlight !== null; },
  });
}

function shouldCreateMainWindow({ windowManager, shutdownController }) {
  if (shutdownController.started) return false;
  const mainWindow = windowManager.getMainWindow();
  return !mainWindow || mainWindow.isDestroyed();
}

async function bootstrapElectronApp({
  electron = require('electron'),
  mqtt = require('mqtt'),
  createDatabase = require('./database.cjs').createDatabase,
  dirname = __dirname,
  env = process.env,
  platform = process.platform,
} = {}) {
  const { app, BrowserWindow, clipboard, ipcMain, Menu, net, shell } = electron;
  const smokeTest = env.INEED_SMOKE_TEST === '1';
  const smokeHistoryKind = readSmokeHistoryKind(env, smokeTest);
  if (smokeTest) {
    const userDataPath = nonblankString(env.INEED_SMOKE_USER_DATA);
    if (userDataPath === null || !path.isAbsolute(userDataPath)) {
      throw new TypeError('INEED_SMOKE_USER_DATA must be an absolute path');
    }
    app.setPath('userData', userDataPath);
  }
  app.setName('Ineed MQTT Tool');
  const db = createDatabase();
  const windowManager = createWindowManager({
    BrowserWindow,
    dirname,
    devServerUrl: env.VITE_DEV_SERVER_URL || '',
    enableDevTools: env.INEED_OPEN_DEVTOOLS === '1',
  });
  const smokeExitGate = createSmokeExitGate({
    beforeExit: () => writeSmokeMarker({
      onError: error => console.error(
        'mqtt-tool-runtime-error:marker', errorMessage(error),
      ),
    }),
    enabled: smokeTest,
    exitProcess: smokeTest ? code => process.reallyExit(code) : () => {},
  });
  let smokeMainWindow = null;
  let smokeHistoryWindow = null;
  let smokeHistoryWebContents = null;
  let smokeHistoryShutdownRequested = false;
  let smokeCleanupComplete = false;
  let runSmokeShutdown = () => Promise.resolve();
  const smokeHistorySettledChannels = new Set();
  const smokeHistoryQueryChannel = smokeHistoryKind === 'logs'
    ? IPC_CHANNELS.dbQueryHistoryLogs
    : IPC_CHANNELS.dbQueryHistoryMessages;
  const mqttCoordinator = createMqttCoordinator({
    mqtt,
    db,
    send(channel, payload) {
      const win = windowManager.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  let nativeUpdater = null;
  const removeHandlers = registerInvokeHandlers({
    ipcMain,
    clipboard,
    db,
    mqttCoordinator,
    windowManager,
    shell,
    net,
    getUpdater: () => nativeUpdater,
    onInvokeSettled(event, channel) {
      if (!smokeTest || event?.sender !== smokeHistoryWebContents) return;
      smokeHistorySettledChannels.add(channel);
      if (
        smokeHistorySettledChannels.has(IPC_CHANNELS.dbGetConnections)
        && smokeHistorySettledChannels.has(smokeHistoryQueryChannel)
        && !smokeHistoryShutdownRequested
      ) {
        smokeHistoryShutdownRequested = true;
        void runSmokeShutdown();
      }
    },
  });
  let closeController = null;
  const shutdownController = createShutdownController({
    mqttCoordinator,
    db,
    removeHandlers,
    getCloseController: () => closeController,
    app,
    onError: (phase, error) => {
      console.error(`[Electron] shutdown ${phase} failed:`, errorMessage(error));
    },
  });
  const shutdown = shutdownController.shutdown;
  let smokeShutdownInFlight = null;
  runSmokeShutdown = () => {
    if (smokeShutdownInFlight !== null) return smokeShutdownInFlight;
    smokeShutdownInFlight = (async () => {
      async function attempt(phase, operation) {
        try {
          await operation();
        } catch (error) {
          console.error(`mqtt-tool-runtime-error:shutdown:${phase}`, errorMessage(error));
        }
      }

      try {
        await attempt('disconnect', () => mqttCoordinator.disconnectAll());
        await attempt('flush', () => mqttCoordinator.flush());
        await attempt('database', () => db.closeDatabase());
      } finally {
        await attempt('mqtt-dispose', () => mqttCoordinator.dispose());
        await attempt('handlers', () => removeHandlers());
        await attempt('close-controller', () => closeController?.dispose());
      }
      smokeCleanupComplete = true;
      smokeExitGate.markCleanupComplete();
      for (const [role, window] of [
        ['history', smokeHistoryWindow],
        ['main', smokeMainWindow],
      ]) {
        if (role === 'main') {
          smokeExitGate.destroyFinalWindowAndExit(role, window);
          continue;
        }
        if (window && !window.isDestroyed()) window.destroy();
        if (!window?.isDestroyed()) {
          console.error(
            `mqtt-tool-runtime-error:shutdown:${role}`,
            `${role} window did not close`,
          );
          continue;
        }
        smokeExitGate.markWindowDestroyed(role, window);
      }
    })();
    return smokeShutdownInFlight;
  };

  function configureSmokeWindow(window, role, onLoaded) {
    if (!smokeTest) return;
    const report = (kind, detail) => {
      console.error(`mqtt-tool-runtime-error:${role}:${kind}`, errorMessage(detail));
    };
    window.webContents.on('preload-error', (_event, _preloadPath, error) => {
      report('preload', error);
    });
    window.webContents.on('did-fail-load', (
      _event, errorCode, errorDescription, _validatedUrl, isMainFrame,
    ) => {
      if (isMainFrame !== false && errorCode !== -3) report('load', errorDescription);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!smokeCleanupComplete && details?.reason !== 'clean-exit') {
        report('renderer', details?.reason);
      }
    });
    window.webContents.on('unresponsive', () => report('unresponsive', 'renderer unresponsive'));
    window.webContents.on('console-message', details => {
      if (details?.level === 'error' || Number(details?.level) >= 2) {
        report('console', details?.message);
      }
    });
    window.webContents.once('did-finish-load', onLoaded);
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'iNeed MQTT Tool', submenu: [{ role: 'quit' }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ]));

  await app.whenReady();
  if (app.isPackaged && !smokeTest) {
    const trustPath = path.join(process.resourcesPath, 'mqtt-update-trust.json');
    let trust;
    try { trust = JSON.parse(fs.readFileSync(trustPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (trust) {
      if (trust.schemaVersion !== 1 || !trust.publicKey) throw new Error('Invalid update trust configuration');
      const { createUpdateController } = require('./updateController.cjs');
      const { requestUpdatePreparation } = require('./updatePreparation.cjs');
      nativeUpdater = createUpdateController({
        engine: require('electron-updater').autoUpdater,
        currentVersion: app.getVersion(), platform, publicKey: trust.publicKey,
        onState: state => {
          const window = windowManager.getMainWindow();
          if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.updateChanged, state);
        },
        prepare: async () => {
          await mqttCoordinator.disconnectAll({ strict: true });
          await mqttCoordinator.flush();
          await requestUpdatePreparation({ window: windowManager.getMainWindow(), ipcMain });
          await db.checkpointForUpdate();
        },
      });
    }
  }
  app.dock?.setIcon(path.join(dirname, 'assets', 'icon.png'));
  const mainWindow = windowManager.createMainWindow(window => {
    if (smokeTest) {
      smokeMainWindow = window;
    }
    configureSmokeWindow(window, 'main', () => {
      console.log('mqtt-tool-ready');
      const historyKind = smokeHistoryKind;
      try {
        const historyWindow = windowManager.createHistoryWindow(
          historyKind,
          'smoke-connection',
          candidate => {
            smokeHistoryWindow = candidate;
            smokeHistoryWebContents = candidate.webContents;
            configureSmokeWindow(candidate, 'history', () => {
              console.log('mqtt-tool-history-opened');
            });
          },
        );
        if (historyWindow.isDestroyed()) {
          throw new Error('history window was destroyed before loading');
        }
      } catch (error) {
        console.error('mqtt-tool-runtime-error:history:control', errorMessage(error));
        void runSmokeShutdown();
      }
    });
  });
  closeController = installCloseHandshake({
    window: mainWindow,
    ipcMain,
    isBlocked: () => nativeUpdater?.getState().phase === 'preparing',
    finalize: () => shutdown(mainWindow),
  });
  app.on('activate', () => {
    if (shouldCreateMainWindow({ windowManager, shutdownController })) {
      const nextWindow = windowManager.createMainWindow();
      closeController = installCloseHandshake({
        window: nextWindow,
        ipcMain,
        isBlocked: () => nativeUpdater?.getState().phase === 'preparing',
        finalize: () => shutdown(nextWindow),
      });
    }
  });
  app.on('window-all-closed', () => {
    if (platform !== 'darwin' && !shutdownController.started) {
      void shutdown(windowManager.getMainWindow());
    }
  });
  return Object.freeze({ db, mqttCoordinator, windowManager, shutdown });
}

module.exports = {
  CLOSE_ACK_TIMEOUT_MS,
  DB_HANDLERS,
  IPC_CHANNELS,
  bootstrapElectronApp,
  checkForUpdates,
  createMqttCoordinator,
  createShutdownController,
  createSmokeExitGate,
  createWindowManager,
  installCloseHandshake,
  isSafeExternalUrl,
  registerInvokeHandlers,
  readSmokeHistoryKind,
  shouldCreateMainWindow,
  validateIpcPayload,
  writeSmokeMarker,
};

if (
  require.main === module
  || (process.type === 'browser' && process.defaultApp === true)
) {
  void bootstrapElectronApp().catch(error => {
    if (process.env.INEED_SMOKE_TEST === '1') {
      try {
        fs.writeSync(2, `[Electron] startup failed: ${error?.stack || errorMessage(error)}\n`);
      } finally {
        process.reallyExit(1);
      }
    }
    console.error('[Electron] startup failed:', error);
    process.exitCode = 1;
  });
}
