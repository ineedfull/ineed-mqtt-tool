/* global document, MutationObserver, queueMicrotask, URLSearchParams, window */

export function installBrowserFixture() {
  const FIXED_NOW = Date.parse('2026-07-24T02:30:45.000Z');
  const NativeDate = Date;
  const clockStart = NativeDate.now();
  let uuidSequence = 0;
  let randomState = 0x1a2b3c4d;

  class FixedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [FIXED_NOW] : args));
    }

    static now() {
      return FIXED_NOW + NativeDate.now() - clockStart;
    }
  }

  Object.defineProperty(window, 'Date', { configurable: true, value: FixedDate });
  Object.defineProperty(Math, 'random', {
    configurable: true,
    value() {
      randomState = (1664525 * randomState + 1013904223) >>> 0;
      return randomState / 0x100000000;
    },
  });
  if (window.crypto?.randomUUID) {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value() {
        uuidSequence += 1;
        return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
      },
    });
  }

  const installDeterministicStyles = () => {
    const style = document.createElement('style');
    style.dataset.visualFixture = 'deterministic';
    style.textContent = `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      html, body, button, input, select, textarea { font-family: "Visual Noto Sans SC" !important; }
      code, pre, .cm-editor, .cm-editor * { font-family: "Visual Roboto Mono" !important; }
    `;
    document.head.append(style);
  };
  if (document.head) installDeterministicStyles();
  else document.addEventListener('DOMContentLoaded', installDeterministicStyles, { once: true });

  const runtimeParam = new URLSearchParams(window.location.search).get('visualRuntime');
  const visualMode = runtimeParam !== null;
  const runtimeName = runtimeParam === 'tauri' ? 'tauri' : 'electron';
  const connections = [
    {
      id: 'connection-1',
      name: 'Local Lab',
      host: '127.0.0.1',
      port: 1883,
      protocol: 'mqtt',
      path: '',
      client_id: 'visual-local',
      username: '',
      password: '',
      keepalive: 60,
      clean_session: 1,
      sort_order: 0,
    },
    {
      id: 'connection-2',
      name: 'Staging Broker',
      host: 'mqtt.staging.invalid',
      port: 8883,
      protocol: 'mqtts',
      path: '',
      client_id: 'visual-staging',
      username: '',
      password: '',
      keepalive: 60,
      clean_session: 1,
      sort_order: 1,
    },
  ];
  const subscriptions = [
    {
      id: 'subscription-1',
      connection_id: 'connection-1',
      topic: 'sensors/#',
      qos: 1,
      status: 'inactive',
      color: '#2f80ed',
      format: 'json',
    },
    {
      id: 'subscription-2',
      connection_id: 'connection-1',
      topic: 'alerts/+',
      qos: 0,
      status: 'inactive',
      color: '#27ae60',
      format: 'text',
    },
    {
      id: 'subscription-3',
      connection_id: 'connection-2',
      topic: 'devices/+/status',
      qos: 0,
      status: 'inactive',
      color: '#9b51e0',
      format: 'json',
    },
  ];
  const realtimeMessages = [
    {
      connId: 'connection-1',
      topic: 'sensors/line-a/temperature',
      payload: '{"temperature":23.6,"unit":"C"}',
      payloadText: '{"temperature":23.6,"unit":"C"}',
      qos: 1,
      retained: false,
      timestamp: FIXED_NOW - 2000,
    },
    {
      connId: 'connection-1',
      topic: 'alerts/gateway',
      payload: 'Gateway recovered',
      payloadText: 'Gateway recovered',
      qos: 0,
      retained: true,
      timestamp: FIXED_NOW - 1000,
    },
    {
      connId: 'connection-1',
      topic: 'sensors/line-b/humidity',
      payload: '{"humidity":48,"unit":"percent"}',
      payloadText: '{"humidity":48,"unit":"percent"}',
      qos: 1,
      retained: false,
      timestamp: FIXED_NOW,
    },
  ];
  const messageHistory = [
    {
      id: 4103,
      connection_id: 'connection-1',
      connection_name: 'Local Lab',
      topic: 'sensors/line-b/humidity',
      payload: '{"humidity":48,"unit":"percent"}',
      payload_text: '{"humidity":48,"unit":"percent"}',
      format: 'json',
      direction: 'in',
      qos: 1,
      retained: 0,
      created_at: '2026-07-24 10:30:45.000',
      time: '2026-07-24 10:30:45.000',
    },
    {
      id: 4102,
      connection_id: 'connection-1',
      connection_name: 'Local Lab',
      topic: 'alerts/gateway',
      payload: 'Gateway recovered',
      payload_text: 'Gateway recovered',
      format: 'text',
      direction: 'in',
      qos: 0,
      retained: 1,
      created_at: '2026-07-24 10:30:44.000',
      time: '2026-07-24 10:30:44.000',
    },
    {
      id: 4101,
      connection_id: 'connection-1',
      connection_name: 'Local Lab',
      topic: 'commands/line-a/mode',
      payload: '{"mode":"automatic"}',
      payload_text: '{"mode":"automatic"}',
      format: 'json',
      direction: 'out',
      qos: 1,
      retained: 0,
      created_at: '2026-07-24 10:30:43.000',
      time: '2026-07-24 10:30:43.000',
    },
  ];
  const logHistory = [
    {
      id: 5103,
      connection_id: 'connection-1',
      connection_name: 'Local Lab',
      level: 'info',
      msg: 'Subscription recovery completed: 2 active',
      created_at: '2026-07-24 10:30:45.000',
      time: '2026-07-24 10:30:45.000',
    },
    {
      id: 5102,
      connection_id: 'connection-1',
      connection_name: 'Local Lab',
      level: 'debug',
      msg: 'Received sensors/line-b/humidity (39 bytes)',
      created_at: '2026-07-24 10:30:44.000',
      time: '2026-07-24 10:30:44.000',
    },
    {
      id: 5101,
      connection_id: 'connection-1',
      connection_name: 'Local Lab',
      level: 'warn',
      msg: 'Broker latency exceeded 200 ms',
      created_at: '2026-07-24 10:30:43.000',
      time: '2026-07-24 10:30:43.000',
    },
  ];
  const settings = {
    logLevel: 'debug',
    maxRealtimeMessages: 300,
    maxLogEntries: 300,
    persistReceiveLogs: false,
    autoFormatReceivedJson: true,
    maxAutoFormatPayloadBytes: 65536,
    payloadFormat: 'auto',
    timestampFormat: 'absolute',
    autoScroll: true,
    highlightJson: true,
    largeFont: false,
    keepalive: 60,
    defaultQos: 1,
    cleanSession: true,
    autoReconnect: false,
  };
  const storageStats = {
    messageCount: 7,
    logCount: 3,
    publishCount: 2,
    totalCount: 12,
    databaseBytes: 8192,
    walBytes: 4096,
    shmBytes: 0,
    totalBytes: 12288,
  };
  const ok = async () => ({ ok: true });
  const cloneRows = rows => rows.map(row => ({ ...row }));
  const historyPage = (rows, filters = {}) => ({
    rows: cloneRows(rows),
    total: rows.length,
    page: Number(filters.page || 1),
    pageSize: Number(filters.pageSize || 100),
  });
  const whenWorkspaceRendered = callback => {
    if (!visualMode) return () => {};
    let disposed = false;
    const observer = new MutationObserver(() => {
      if (disposed || document.querySelectorAll('.conn-item').length !== connections.length) return;
      disposed = true;
      observer.disconnect();
      queueMicrotask(callback);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
    };
  };
  const subscribeMessages = handler => whenWorkspaceRendered(() => handler(cloneRows(realtimeMessages)));
  const subscribeStatus = handler => whenWorkspaceRendered(() => handler({
    connId: 'connection-1',
    status: 'connected',
  }));

  const adapter = {
    runtimeName,
    connection: {
      list: async () => cloneRows(connections),
      save: ok,
      delete: ok,
      messageCounts: async () => [
        { connection_id: 'connection-1', messages_in: 18, messages_out: 4 },
        { connection_id: 'connection-2', messages_in: 2, messages_out: 0 },
      ],
    },
    subscription: {
      list: async connectionId => cloneRows(subscriptions.filter(row => row.connection_id === connectionId)),
      add: ok,
      remove: ok,
    },
    mqtt: {
      connect: ok,
      disconnect: ok,
      subscribe: ok,
      unsubscribe: ok,
      publish: ok,
      onMessages: subscribeMessages,
      onStatus: subscribeStatus,
    },
    history: {
      saveMessages: ok,
      saveLogs: ok,
      queryMessages: async filters => historyPage(visualMode ? messageHistory : [], filters),
      deleteMessage: ok,
      clearMessages: ok,
      queryLogs: async filters => historyPage(visualMode ? logHistory : [], filters),
      deleteLog: ok,
      clearLogs: ok,
    },
    publishHistory: {
      list: async () => [],
      save: ok,
    },
    settings: {
      getAll: async () => ({ ...settings }),
      save: ok,
    },
    storage: {
      stats: async () => ({ ...storageStats }),
      clearHistory: async () => ({ ...storageStats }),
    },
    clipboard: {
      readText: async () => '',
      writeText: ok,
    },
    window: {
      openHistory: ok,
      openExternal: ok,
    },
    lifecycle: {
      onBeforeClose: () => () => {},
    },
    update: {
      check: async () => ({ available: false, version: '', url: '', force: false, description: '' }),
    },
  };

  window.ineedMqttAdapter = adapter;
  window.__INEED_VISUAL_ADAPTER__ = adapter;
  window.ineedMqtt = {
    runtime: 'electron',
    db: {
      getConnections: adapter.connection.list,
      saveConnection: adapter.connection.save,
      deleteConnection: adapter.connection.delete,
      getMessageCounts: adapter.connection.messageCounts,
      getSubscriptions: adapter.subscription.list,
      addSubscription: adapter.subscription.add,
      removeSubscription: adapter.subscription.remove,
      saveMessage: ok,
      saveMessages: adapter.history.saveMessages,
      savePublish: adapter.publishHistory.save,
      saveLog: ok,
      saveLogs: adapter.history.saveLogs,
      queryHistoryMessages: adapter.history.queryMessages,
      deleteHistoryMessage: adapter.history.deleteMessage,
      clearHistoryMessages: adapter.history.clearMessages,
      queryHistoryLogs: adapter.history.queryLogs,
      deleteHistoryLog: adapter.history.deleteLog,
      clearHistoryLogs: adapter.history.clearLogs,
      getPublishHistory: adapter.publishHistory.list,
      getAllSettings: adapter.settings.getAll,
      saveSetting: adapter.settings.save,
      getStorageStats: adapter.storage.stats,
      clearHistoryStorage: adapter.storage.clearHistory,
    },
    mqtt: {
      connect: adapter.mqtt.connect,
      disconnect: adapter.mqtt.disconnect,
      subscribe: adapter.mqtt.subscribe,
      unsubscribe: adapter.mqtt.unsubscribe,
      publish: adapter.mqtt.publish,
      onMessages: adapter.mqtt.onMessages,
      onStatus: adapter.mqtt.onStatus,
    },
    window: {
      openHistory: adapter.window.openHistory,
      openExternal: adapter.window.openExternal,
    },
  };
  window.__visualFixture = {
    fixedNow: FIXED_NOW,
    messageCount: realtimeMessages.length,
    runtimeName,
  };
}

export const installPreviewAdapter = installBrowserFixture;
