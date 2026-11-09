import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DB_HANDLERS,
  IPC_CHANNELS,
  createWindowManager,
  registerInvokeHandlers,
  validateIpcPayload,
} = require('../electron/main.cjs');
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = { url: '' };
    this.windowOpenHandler = null;
  }
  openDevTools() {}
  send() {}
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeBrowserWindow extends EventEmitter {
  static created = [];
  static getAllWindows() { return this.created.filter(window => !window.destroyed); }
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new FakeWebContents();
    FakeBrowserWindow.created.push(this);
  }
  focus() {}
  isDestroyed() { return this.destroyed; }
  loadFile(...args) {
    this.loaded = args;
    const url = pathToFileURL(args[0]);
    for (const [key, value] of Object.entries(args[1]?.query || {})) {
      url.searchParams.set(key, value);
    }
    this.webContents.mainFrame.url = url.toString();
    return Promise.resolve();
  }
  loadURL(...args) {
    this.loaded = args;
    this.webContents.mainFrame.url = args[0];
    return Promise.resolve();
  }
  closeForTest() { this.destroyed = true; this.emit('closed'); }
}

function packagedUrl(query = null) {
  const url = pathToFileURL(join(root, 'dist', 'index.html'));
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  return url.toString();
}

function eventFor(window, url) {
  assert.equal(window.webContents.mainFrame.url, url);
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

function createWindows() {
  FakeBrowserWindow.created = [];
  const manager = createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: '',
  });
  const primary = manager.createMainWindow();
  const messages = manager.createHistoryWindow('messages', 'conn-m');
  const logs = manager.createHistoryWindow('logs', 'conn-l');
  return {
    manager,
    primary,
    messages,
    logs,
    primaryEvent: eventFor(primary, packagedUrl()),
    messagesEvent: eventFor(messages, packagedUrl({ history: 'messages', connId: 'conn-m' })),
    logsEvent: eventFor(logs, packagedUrl({ history: 'logs', connId: 'conn-l' })),
  };
}

test('tracked main and history windows enforce the exact IPC capability matrix', () => {
  const { manager, primaryEvent, messagesEvent, logsEvent } = createWindows();
  const invokeChannels = Object.values(IPC_CHANNELS).filter(channel => ![
    IPC_CHANNELS.mqttMessages,
    IPC_CHANNELS.mqttStatus,
    IPC_CHANNELS.lifecycleBeforeClose,
    IPC_CHANNELS.lifecycleBeforeCloseAck,
    IPC_CHANNELS.updateChanged,
  ].includes(channel));
  const common = [IPC_CHANNELS.dbGetConnections, IPC_CHANNELS.dbGetAllSettings,
    IPC_CHANNELS.clipboardReadText, IPC_CHANNELS.clipboardWriteText];
  const messageOnly = [
    IPC_CHANNELS.dbQueryHistoryMessages,
    IPC_CHANNELS.dbDeleteHistoryMessage,
    IPC_CHANNELS.dbClearHistoryMessages,
  ];
  const logOnly = [
    IPC_CHANNELS.dbQueryHistoryLogs,
    IPC_CHANNELS.dbDeleteHistoryLog,
    IPC_CHANNELS.dbClearHistoryLogs,
  ];

  for (const channel of invokeChannels) {
    assert.equal(manager.authorizeIpc(primaryEvent, channel), true, `main ${channel}`);
    assert.equal(
      manager.authorizeIpc(messagesEvent, channel), [...common, ...messageOnly].includes(channel),
      `messages ${channel}`,
    );
    assert.equal(
      manager.authorizeIpc(logsEvent, channel), [...common, ...logOnly].includes(channel),
      `logs ${channel}`,
    );
  }
});

test('both history windows can read display settings without gaining settings write access', async () => {
  const handlers = new Map();
  const { manager, messagesEvent, logsEvent } = createWindows();
  const saved = { largeFont: 'true' };
  registerInvokeHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    db: {
      ...Object.fromEntries(Object.values(DB_HANDLERS).map(method => [method, () => undefined])),
      getAllSettings: () => saved,
      saveSetting: () => { throw new Error('history must not write settings'); },
    },
    windowManager: manager,
  });
  for (const event of [messagesEvent, logsEvent]) {
    assert.deepEqual(await handlers.get(IPC_CHANNELS.dbGetAllSettings)(event), saved);
    await assert.rejects(
      () => handlers.get(IPC_CHANNELS.dbSaveSetting)(event, 'largeFont', false),
      /IPC sender is not authorized/iu,
    );
  }
});

test('IPC authorization rejects unknown, destroyed, spoofed URL, and cross-kind senders', () => {
  const { manager, messages, messagesEvent } = createWindows();
  assert.equal(manager.authorizeIpc({
    sender: new FakeWebContents(),
    senderFrame: { url: packagedUrl() },
  }, IPC_CHANNELS.dbGetConnections), false);
  assert.equal(manager.authorizeIpc({
    sender: messages.webContents,
    senderFrame: { url: 'https://attacker.example/' },
  }, IPC_CHANNELS.dbGetConnections), false);
  assert.equal(manager.authorizeIpc({
    sender: messages.webContents,
    senderFrame: { url: messages.webContents.mainFrame.url },
  }, IPC_CHANNELS.dbGetConnections), false);
  assert.equal(manager.authorizeIpc(messagesEvent, IPC_CHANNELS.dbQueryHistoryLogs), false);
  assert.equal(manager.authorizeIpc(messagesEvent, 'unknown:channel'), false);
  messages.closeForTest();
  assert.equal(manager.authorizeIpc(messagesEvent, IPC_CHANNELS.dbGetConnections), false);
});

test('failed history reuse restores authorization to the visible old page', async () => {
  const { manager, messages } = createWindows();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  const oldUrl = messages.webContents.mainFrame.url;
  const newUrl = packagedUrl({ history: 'messages', connId: 'conn-new' });
  messages.loadFile = () => Promise.reject(new Error('reload failed'));

  manager.createHistoryWindow('messages', 'conn-new');
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(manager.authorizeIpc(eventFor(messages, oldUrl), IPC_CHANNELS.dbGetConnections), true);
  messages.webContents.mainFrame.url = newUrl;
  assert.equal(manager.authorizeIpc(eventFor(messages, newUrl), IPC_CHANNELS.dbGetConnections), false);
});

test('history reuse serializes navigation and commits only the latest successful target', async () => {
  const errors = [];
  FakeBrowserWindow.created = [];
  const manager = createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: '',
    onNavigationError: error => errors.push(error.message),
  });
  const messages = manager.createHistoryWindow('messages', 'conn-1');
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  const navigations = [];
  messages.loadFile = (file, options) => new Promise((resolvePromise, rejectPromise) => {
    navigations.push({ file, options, resolvePromise, rejectPromise });
  }).then(() => {
    const url = pathToFileURL(file);
    for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
    messages.webContents.mainFrame.url = url.toString();
  });

  manager.createHistoryWindow('messages', 'conn-2');
  manager.createHistoryWindow('messages', 'conn-3');
  assert.equal(navigations.length, 1);
  navigations[0].rejectPromise(new Error('conn-2 failed'));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(navigations.length, 2);
  navigations[1].resolvePromise();
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  const latestUrl = packagedUrl({ history: 'messages', connId: 'conn-3' });
  assert.equal(manager.authorizeIpc(eventFor(messages, latestUrl), IPC_CHANNELS.dbGetConnections), true);
  messages.webContents.mainFrame.url = packagedUrl({ history: 'messages', connId: 'conn-2' });
  assert.equal(manager.authorizeIpc({
    sender: messages.webContents,
    senderFrame: messages.webContents.mainFrame,
  }, IPC_CHANNELS.dbGetConnections), false);
  assert.deepEqual(errors, ['conn-2 failed']);
});

test('every invoke wrapper rejects an unauthorized sender before dispatch', async () => {
  const handlers = new Map();
  const { manager } = createWindows();
  const calls = [];
  const db = Object.fromEntries(Object.values(DB_HANDLERS).map(method => [method, () => calls.push(method)]));
  registerInvokeHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    db,
    mqttCoordinator: Object.fromEntries(
      ['connect', 'disconnect', 'subscribe', 'unsubscribe', 'publish'].map(method => [method, () => calls.push(method)]),
    ),
    windowManager: manager,
    clipboard: { readText: () => calls.push('readText'), writeText: () => calls.push('writeText') },
    shell: { openExternal: () => calls.push('openExternal') },
    net: { fetch: () => calls.push('fetch') },
  });
  const attacker = {
    sender: new FakeWebContents(),
    senderFrame: { url: 'https://attacker.example/' },
  };

  assert.equal(handlers.size, 35);
  for (const [channel, handler] of handlers) {
    await assert.rejects(async () => handler(attacker), /IPC sender is not authorized/iu, channel);
  }
  assert.deepEqual(calls, []);
});

test('all app windows deny popup, renderer navigation, and webview attachment', () => {
  const { primary, messages, logs } = createWindows();
  for (const window of [primary, messages, logs]) {
    assert.deepEqual(window.webContents.windowOpenHandler({ url: 'https://attacker.example/' }), {
      action: 'deny',
    });
    let navigationPrevented = 0;
    let webviewPrevented = 0;
    window.webContents.emit('will-navigate', {
      preventDefault() { navigationPrevented += 1; },
    }, 'https://attacker.example/');
    window.webContents.emit('will-attach-webview', {
      preventDefault() { webviewPrevented += 1; },
    });
    assert.equal(navigationPrevented, 1);
    assert.equal(webviewPrevented, 1);
  }
});

test('IPC payload validation bounds batches, individual items, total bytes, and serialization', () => {
  assert.doesNotThrow(() => validateIpcPayload(
    IPC_CHANNELS.dbSaveMessages,
    [[{ payload: '1234' }, { payload: '56' }]],
    { maxBatchItems: 2, maxItemBytes: 20, maxTotalBytes: 40 },
  ));
  assert.throws(() => validateIpcPayload(
    IPC_CHANNELS.dbSaveMessages,
    [[{}, {}, {}]],
    { maxBatchItems: 2, maxItemBytes: 20, maxTotalBytes: 40 },
  ), /batch item limit/iu);
  assert.throws(() => validateIpcPayload(
    IPC_CHANNELS.mqttPublish,
    ['conn-1', 'topic', '12345', 0, false],
    { maxBatchItems: 2, maxItemBytes: 4, maxTotalBytes: 40 },
  ), /item byte limit/iu);
  assert.throws(() => validateIpcPayload(
    IPC_CHANNELS.dbSaveLogs,
    [[{ msg: '1234' }, { msg: '5678' }]],
    { maxBatchItems: 2, maxItemBytes: 20, maxTotalBytes: 20 },
  ), /total byte limit/iu);
  const circular = {};
  circular.self = circular;
  assert.throws(() => validateIpcPayload(
    IPC_CHANNELS.dbSaveSetting,
    ['key', circular],
  ), /serializable/iu);
});

test('invoke wrappers reject oversized payloads before MQTT dispatch', async () => {
  const handlers = new Map();
  const { manager, primaryEvent } = createWindows();
  const calls = [];
  const db = Object.fromEntries(Object.values(DB_HANDLERS).map(method => [method, () => undefined]));
  registerInvokeHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    db,
    mqttCoordinator: {
      connect() {}, disconnect() {}, subscribe() {}, unsubscribe() {},
      publish() { calls.push('publish'); },
    },
    windowManager: manager,
    shell: { openExternal() {} },
    net: { fetch() {} },
  });

  await assert.rejects(() => handlers.get(IPC_CHANNELS.mqttPublish)(
    primaryEvent,
    'conn-1',
    'topic',
    'x'.repeat(1_048_577),
    0,
    false,
  ), /item byte limit/iu);
  assert.deepEqual(calls, []);
});
