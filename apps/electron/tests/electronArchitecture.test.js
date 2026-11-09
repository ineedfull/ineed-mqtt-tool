import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const main = require('../electron/main.cjs');

const EXPECTED_CHANNELS = Object.freeze([
  'db:get-connections', 'db:save-connection', 'db:delete-connection',
  'db:get-message-counts', 'db:get-subscriptions', 'db:add-subscription',
  'db:remove-subscription', 'db:save-messages', 'db:save-logs',
  'db:query-history-messages', 'db:delete-history-message',
  'db:clear-history-messages', 'db:query-history-logs',
  'db:delete-history-log', 'db:clear-history-logs', 'db:get-publish-history',
  'db:save-publish', 'db:get-all-settings', 'db:save-setting',
  'db:get-storage-stats', 'db:clear-history-storage', 'mqtt:connect',
  'mqtt:disconnect', 'mqtt:subscribe', 'mqtt:unsubscribe', 'mqtt:publish',
  'mqtt:messages', 'mqtt:status', 'clipboard:read-text', 'clipboard:write-text', 'window:open-history',
  'window:open-external', 'lifecycle:before-close',
  'lifecycle:before-close-ack', 'update:check',
  'update:state', 'update:download', 'update:cancel', 'update:install', 'update:changed',
]);

test('main and preload expose the same exact 40-channel allowlist', async () => {
  const source = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const declaration = source.match(/const IPC_CHANNELS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(declaration);
  const preloadChannels = [...declaration[1].matchAll(/:\s*'([^']+)'/g)]
    .map(([, channel]) => channel);

  assert.deepEqual(Object.values(main.IPC_CHANNELS), EXPECTED_CHANNELS);
  assert.deepEqual(preloadChannels, EXPECTED_CHANNELS);
});

test('main declares exactly 21 database invoke handlers', () => {
  assert.equal(Object.keys(main.DB_HANDLERS).length, 21);
  assert.deepEqual(Object.keys(main.DB_HANDLERS), EXPECTED_CHANNELS.slice(0, 21));
});

test('main and history BrowserWindows are isolated and use the exact preload', () => {
  const created = [];
  class FakeBrowserWindow {
    static getAllWindows() { return created; }
    constructor(options) {
      this.options = options;
      this.webContents = { openDevTools() {}, send() {} };
      created.push(this);
    }
    loadFile(...args) { this.loaded = args; }
    loadURL(...args) { this.loaded = args; }
    isDestroyed() { return false; }
    focus() {}
    on() {}
  }
  const windows = main.createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: '',
  });

  const primary = windows.createMainWindow();
  const history = windows.createHistoryWindow('logs', 'conn-1');
  const expectedPreload = join(root, 'electron', 'preload.cjs');
  for (const win of [primary, history]) {
    assert.deepEqual(win.options.webPreferences, {
      preload: expectedPreload,
      contextIsolation: true,
      nodeIntegration: false,
    });
    assert.deepEqual(win.loaded[0], join(root, 'dist', 'index.html'));
  }
  assert.deepEqual(history.loaded[1], { query: { history: 'logs', connId: 'conn-1' } });
});

test('development window opens DevTools only when explicitly enabled', () => {
  let opened = 0;
  class FakeBrowserWindow {
    static getAllWindows() { return []; }
    constructor() {
      this.webContents = { openDevTools() { opened += 1; } };
    }
    loadURL() {}
    isDestroyed() { return false; }
    on() {}
  }
  const options = {
    BrowserWindow: FakeBrowserWindow,
    devServerUrl: 'http://127.0.0.1:5188/',
  };

  main.createWindowManager(options).createMainWindow();
  assert.equal(opened, 0);
  main.createWindowManager({ ...options, enableDevTools: true }).createMainWindow();
  assert.equal(opened, 1);
});

function createHistoryWindowFake() {
  const created = [];
  class FakeBrowserWindow {
    static getAllWindows() { return created.filter(win => !win.destroyed); }
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.focusCount = 0;
      this.listeners = new Map();
      this.loadFileCalls = [];
      this.loadURLCalls = [];
      this.webContents = { openDevTools() {}, send() {} };
      created.push(this);
    }
    focus() { this.focusCount += 1; }
    isDestroyed() { return this.destroyed; }
    loadFile(...args) { this.loadFileCalls.push(args); return Promise.resolve(); }
    loadURL(...args) { this.loadURLCalls.push(args); return Promise.resolve(); }
    on(event, listener) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }
    closeForTest() {
      this.destroyed = true;
      for (const listener of this.listeners.get('closed') || []) listener();
    }
  }
  return { created, FakeBrowserWindow };
}

test('closed windows release their records without reading destroyed native properties', async () => {
  const { FakeBrowserWindow } = createHistoryWindowFake();
  const windows = main.createWindowManager({ BrowserWindow: FakeBrowserWindow });
  const primary = windows.createMainWindow();
  const history = windows.createHistoryWindow('messages', 'conn-1');
  for (const win of [primary, history]) {
    const contents = win.webContents;
    Object.defineProperty(win, 'webContents', {
      get() {
        if (win.destroyed) throw new TypeError('Object has been destroyed');
        return contents;
      },
    });
    assert.doesNotThrow(() => win.closeForTest());
  }
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.deepEqual(windows.getWindows(), []);
  assert.equal(windows.getMainWindow(), null);
  assert.notStrictEqual(windows.createHistoryWindow('messages', 'conn-2'), history);
});

test('packaged history windows reuse one identity per kind and navigate to the latest connection', async () => {
  const { created, FakeBrowserWindow } = createHistoryWindowFake();
  const windows = main.createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: '',
  });

  const messages = windows.createHistoryWindow('messages', 'conn-1');
  const reusedMessages = windows.createHistoryWindow('messages', 'conn-2');
  const logs = windows.createHistoryWindow('logs', 'conn-1');
  const reusedLogs = windows.createHistoryWindow('logs', 'conn-2');
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.strictEqual(reusedMessages, messages);
  assert.strictEqual(reusedLogs, logs);
  assert.notStrictEqual(messages, logs);
  assert.equal(created.length, 2);
  assert.equal(messages.focusCount, 1);
  assert.equal(logs.focusCount, 1);
  assert.deepEqual(messages.loadFileCalls, [
    [join(root, 'dist', 'index.html'), { query: { history: 'messages', connId: 'conn-1' } }],
    [join(root, 'dist', 'index.html'), { query: { history: 'messages', connId: 'conn-2' } }],
  ]);

  messages.closeForTest();
  assert.equal(windows.getWindows().includes(messages), false);
  const rebuiltMessages = windows.createHistoryWindow('messages', 'conn-3');
  assert.notStrictEqual(rebuiltMessages, messages);
  assert.equal(created.length, 3);
  assert.deepEqual(rebuiltMessages.loadFileCalls[0][1], {
    query: { history: 'messages', connId: 'conn-3' },
  });
});

test('development history reuse updates the URL query without opening another window', async () => {
  const { created, FakeBrowserWindow } = createHistoryWindowFake();
  const windows = main.createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: 'http://127.0.0.1:5173/',
  });

  const first = windows.createHistoryWindow('messages', 'conn/one');
  const second = windows.createHistoryWindow('messages', 'conn two');
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.strictEqual(second, first);
  assert.equal(created.length, 1);
  assert.deepEqual(first.loadURLCalls, [
    ['http://127.0.0.1:5173/?history=messages&connId=conn%2Fone'],
    ['http://127.0.0.1:5173/?history=messages&connId=conn+two'],
  ]);
  assert.equal(first.focusCount, 1);
});

test('history navigation failures are contained and retain the kind identity', async () => {
  const errors = [];
  const { created, FakeBrowserWindow } = createHistoryWindowFake();
  FakeBrowserWindow.prototype.loadFile = function loadFile(...args) {
    this.loadFileCalls.push(args);
    return Promise.reject(new Error('navigation failed'));
  };
  const windows = main.createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: '',
    onNavigationError: error => errors.push(error.message),
  });

  const first = windows.createHistoryWindow('logs', 'conn-1');
  const second = windows.createHistoryWindow('logs', 'conn-2');
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.strictEqual(second, first);
  assert.equal(created.length, 1);
  assert.deepEqual(errors, ['navigation failed', 'navigation failed']);
});

test('history window rejects invalid kinds and connection ids', () => {
  class FakeBrowserWindow { static getAllWindows() { return []; } }
  const windows = main.createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    dirname: join(root, 'electron'),
    devServerUrl: '',
  });

  assert.throws(() => windows.createHistoryWindow('other', 'conn-1'), /history kind/i);
  assert.throws(() => windows.createHistoryWindow('messages', ''), /connection id/i);
  assert.throws(() => windows.createHistoryWindow('logs', { toString() {} }), /connection id/i);
});

test('activation depends on the main window rather than unrelated history windows', () => {
  assert.equal(main.shouldCreateMainWindow({
    windowManager: { getMainWindow: () => null },
    shutdownController: { started: false },
  }), true);
  assert.equal(main.shouldCreateMainWindow({
    windowManager: { getMainWindow: () => ({ isDestroyed: () => false }) },
    shutdownController: { started: false },
  }), false);
  assert.equal(main.shouldCreateMainWindow({
    windowManager: { getMainWindow: () => null },
    shutdownController: { started: true },
  }), false);
});

test('Electron package keeps its runtime entry, scripts, identity, and native dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(manifest.main, 'electron/main.cjs');
  assert.equal(manifest.productName, 'Ineed MQTT Tool');
  assert.equal(manifest.build.appId, 'com.ineedfull.mqtt-tool');
  assert.equal(manifest.dependencies.mqtt, '^5.15.2');
  assert.equal(manifest.devDependencies.concurrently, '^9.2.1');
  assert.equal(manifest.devDependencies['cross-env'], '^10.1.0');
  assert.equal(manifest.devDependencies['wait-on'], '^9.0.3');
  assert.match(manifest.scripts.dev, /electron/);
  assert.equal(manifest.scripts.test, 'node --test');
});

test('main module is import-safe and contains no remote or permissive renderer settings', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /@electron\/remote|enableRemoteModule|nodeIntegration:\s*true|contextIsolation:\s*false/);
  assert.match(source, /require\.main === module/);
});
