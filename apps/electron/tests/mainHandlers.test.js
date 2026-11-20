import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { version: installedVersion } = require('../../../package.json');
const {
  DB_HANDLERS,
  checkForUpdates,
  isSafeExternalUrl,
  registerInvokeHandlers,
} = require('../electron/main.cjs');

const authorizedEvent = Object.freeze({
  sender: Object.freeze({ id: 'trusted-sender' }),
  senderFrame: Object.freeze({ url: 'file:///trusted-app.html' }),
});

test('clipboard handlers preserve full text, reject invalid payloads, and propagate native failures', async () => {
  const handlers = new Map();
  let text = '';
  let failure = null;
  registerInvokeHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    db: Object.fromEntries(Object.values(DB_HANDLERS).map(method => [method, () => undefined])),
    windowManager: { authorizeIpc: () => true },
    clipboard: {
      readText() { return text; },
      writeText(value) {
        if (failure) throw failure;
        text = value;
      },
    },
  });
  const read = handlers.get('clipboard:read-text');
  const write = handlers.get('clipboard:write-text');
  const fullText = '中文\n'.repeat(200_000);
  assert.deepEqual(await write(authorizedEvent, fullText), { ok: true });
  assert.equal(await read(authorizedEvent), fullText);
  await assert.rejects(() => write(authorizedEvent, {}), /Clipboard text must be a string/);
  await assert.rejects(() => write(authorizedEvent, 'a'.repeat(33_554_433)), /byte limit exceeded/);
  assert.equal(text, fullText, 'invalid writes must not change the clipboard');
  failure = new Error('Native clipboard unavailable');
  await assert.rejects(() => write(authorizedEvent, 'not written'), /Native clipboard unavailable/);
});

test('all 21 database channels delegate to one database factory object', async () => {
  const calls = [];
  const handlers = new Map();
  const ipcMain = { handle(channel, handler) { handlers.set(channel, handler); } };
  const db = {};
  for (const method of Object.values(DB_HANDLERS)) {
    db[method] = (...args) => {
      calls.push([method, ...args]);
      return method;
    };
  }
  registerInvokeHandlers({
    ipcMain,
    db,
    mqttCoordinator: Object.fromEntries(
      ['connect', 'disconnect', 'subscribe', 'unsubscribe', 'publish'].map(method => [method, () => ({ ok: true })]),
    ),
    windowManager: { authorizeIpc: () => true, createHistoryWindow() {} },
    shell: { openExternal: async () => {} },
    net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
  });

  assert.equal(handlers.size, 35);
  for (const [channel, method] of Object.entries(DB_HANDLERS)) {
    assert.equal(await handlers.get(channel)(authorizedEvent, 'a', 'b'), method);
    assert.deepEqual(
      calls.at(-1),
      channel === 'db:delete-connection' ? [method, 'a'] : [method, 'a', 'b'],
    );
  }
});

test('external URLs allow only credential-free absolute HTTPS addresses', () => {
  assert.equal(isSafeExternalUrl('https://downloads.example/app.zip'), true);
  assert.equal(isSafeExternalUrl('https://downloads.example'), true);
  for (const value of [
    'http://downloads.example/app.zip', '/relative', 'https://user:pass@example.com',
    'javascript:alert(1)', 'https://', ' https://example.com',
    new URL('https://example.com'),
  ]) {
    assert.equal(isSafeExternalUrl(value), false, String(value));
  }
});

test('connection deletion waits for native MQTT disconnect before database deletion', async () => {
  const order = [];
  const handlers = new Map();
  const db = Object.fromEntries(Object.values(DB_HANDLERS).map(method => [method, () => undefined]));
  db.deleteConnection = id => order.push(['delete', id]);
  registerInvokeHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    db,
    mqttCoordinator: {
      connect() {}, subscribe() {}, unsubscribe() {}, publish() {},
      async disconnect(id) { order.push(['disconnect', id]); },
    },
    windowManager: { authorizeIpc: () => true, createHistoryWindow() {} },
    shell: { openExternal() {} },
    net: { fetch() {} },
  });

  await handlers.get('db:delete-connection')(authorizedEvent, 'conn-1');
  assert.deepEqual(order, [['disconnect', 'conn-1'], ['delete', 'conn-1']]);
});

function updateResponse(body, {
  chunks,
  contentLength,
  ok = true,
  status = 200,
  stream = true,
} = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  const responseChunks = chunks || [bytes];
  const state = { cancelCalls: 0, readCalls: 0, textCalls: 0 };
  return {
    ok,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() !== 'content-length') return null;
        return contentLength === undefined ? String(bytes.byteLength) : contentLength;
      },
    },
    body: stream ? {
      async cancel() { state.cancelCalls += 1; },
      getReader() {
        let index = 0;
        return {
          async cancel() { state.cancelCalls += 1; },
          async read() {
            state.readCalls += 1;
            if (index >= responseChunks.length) return { done: true, value: undefined };
            return { done: false, value: responseChunks[index++] };
          },
        };
      },
    } : null,
    state,
    text: async () => { state.textCalls += 1; return text; },
  };
}

test('update check gets the Nginx manifest and selects the installed channel', async () => {
  const requested = [];
  const response = updateResponse({
    schemaVersion: 1,
    appId: 'ineed-mqtt-tool',
    releases: {
      'electron-macos-arm64-dmg': {
        version: '0.1.1',
        url: 'https://example.com/app.zip',
        force: true,
        description: 'Security fixes',
      },
    },
  });
  const success = await checkForUpdates({
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '0.1.0',
    fetch: async (url, options) => {
      requested.push([url, options]);
      return response;
    },
  });
  assert.equal(requested[0][0], 'https://mqtt.ineedfull.com/updates/latest.json');
  assert.equal(requested[0][1].method, 'GET');
  assert.equal(requested[0][1].cache, 'no-store');
  assert.equal(requested[0][1].redirect, 'manual');
  assert.equal(requested[0][1].body, undefined);
  assert.ok(requested[0][1].signal instanceof AbortSignal);
  assert.equal(requested[0][1].signal.aborted, false);
  assert.equal(response.state.cancelCalls, 0);
  assert.deepEqual(success, {
    available: true,
    version: '0.1.1',
    url: 'https://example.com/app.zip',
    force: true,
    description: 'Security fixes',
  });
});

test('update check returns a normalized unavailable result', async () => {
  assert.deepEqual(await checkForUpdates({
    fetch: async () => updateResponse({
      schemaVersion: 1,
      appId: 'ineed-mqtt-tool',
      releases: {},
    }),
  }), {
    available: false,
    version: installedVersion,
    url: '',
    force: false,
    description: '',
  });
});

test('update check ignores a release at or below the installed version', async () => {
  for (const version of ['0.0.9', '0.1.0']) {
    const result = await checkForUpdates({
      platform: 'darwin', arch: 'arm64', currentVersion: '0.1.0',
      fetch: async () => updateResponse({
        schemaVersion: 1,
        appId: 'ineed-mqtt-tool',
        releases: { 'electron-macos-arm64-dmg': { version, url: 'https://example.com/app' } },
      }),
    });
    assert.equal(result.available, false);
    assert.equal(result.version, '0.1.0');
  }
});

test('update check rejects unsupported release channels before the network request', async () => {
  let requests = 0;
  for (const [platform, arch] of [['win32', 'arm64'], ['linux', 'arm64'], ['freebsd', 'x64']]) {
    await assert.rejects(() => checkForUpdates({
      platform,
      arch,
      fetch: async () => { requests += 1; },
    }), /Unsupported update platform/);
  }
  assert.equal(requests, 0);
});

test('update check distinguishes Linux deb from AppImage installations', async () => {
  const results = [];
  for (const appImage of [false, true]) {
    results.push(await checkForUpdates({
      platform: 'linux',
      arch: 'x64',
      appImage,
      fetch: async () => updateResponse({
        schemaVersion: 1,
        appId: 'ineed-mqtt-tool',
        releases: {
          'electron-linux-x64-deb': { version: '0.1.1', url: 'https://example.com/deb' },
          'electron-linux-x64-appimage': { version: '0.1.2', url: 'https://example.com/appimage' },
        },
      }),
    }));
  }
  assert.deepEqual(results.map(result => result.version), ['0.1.1', '0.1.2']);
});

test('update check rejects HTTP, schema, URL, malformed, and oversized responses', async () => {
  const manifest = release => ({
    schemaVersion: 1,
    appId: 'ineed-mqtt-tool',
    releases: { 'electron-macos-arm64-dmg': release },
  });
  const invalidResponses = [
    [updateResponse('', { ok: false, status: 503 }), /503/],
    [updateResponse({ schemaVersion: 2, appId: 'ineed-mqtt-tool', releases: {} }), /schemaVersion/],
    [updateResponse({ schemaVersion: 1, appId: 'another-app', releases: {} }), /appId/],
    [updateResponse({ schemaVersion: 1, appId: 'ineed-mqtt-tool', releases: [] }), /releases/],
    [updateResponse(manifest({ version: '', url: 'https://example.com' })), /version/],
    [updateResponse(manifest({ version: ['0.1.1'], url: 'https://example.com' })), /version/],
    [updateResponse(manifest({ version: '0.1.1', url: 'http://example.com' })), /url/],
    [updateResponse(manifest({ version: '0.1.1', url: 'https://example.com', force: 1 })), /force/],
    [updateResponse(manifest({ version: '0.1.1', url: 'https://example.com', description: 1 })), /description/],
    [updateResponse('{broken'), /JSON/],
    [updateResponse('x'.repeat(70_000)), /too large/],
  ];
  for (const [response, expected] of invalidResponses) {
    await assert.rejects(() => checkForUpdates({ fetch: async () => response }), expected);
  }
});

test('update check validates declared response size before reading', async () => {
  for (const contentLength of ['-1', '1.5', 'unknown', '1, 2', '65537']) {
    let signal;
    const response = updateResponse({ success: true, data: {} }, { contentLength });
    await assert.rejects(
      () => checkForUpdates({
        fetch: async (_url, options) => { signal = options.signal; return response; },
      }),
      /content-length|too large/iu,
      contentLength,
    );
    assert.equal(response.state.readCalls, 0, contentLength);
    assert.equal(response.state.textCalls, 0, contentLength);
    assert.equal(response.state.cancelCalls, 1, contentLength);
    assert.equal(signal.aborted, true, contentLength);
  }
});

test('update check cancels and aborts an overflowing stream without calling text', async () => {
  let signal;
  const response = updateResponse('ignored', {
    contentLength: null,
    chunks: [new Uint8Array(65_536), new Uint8Array([1])],
  });
  await assert.rejects(() => checkForUpdates({
    fetch: async (_url, options) => { signal = options.signal; return response; },
  }), /too large/iu);

  assert.equal(response.state.cancelCalls, 1);
  assert.equal(response.state.textCalls, 0);
  assert.equal(signal.aborted, true);
});

test('update check timeout covers a reader that never settles', async () => {
  let signal;
  let cancelled = 0;
  const response = updateResponse('ignored', { contentLength: null });
  response.body.getReader = () => ({
    cancel() { cancelled += 1; },
    read() { return new Promise(() => {}); },
  });
  const result = checkForUpdates({
    timeoutMs: 5,
    fetch: async (_url, options) => { signal = options.signal; return response; },
  });
  const outcome = await Promise.race([
    result.then(() => 'resolved', error => error),
    new Promise(resolvePromise => setTimeout(() => resolvePromise('still pending'), 50)),
  ]);

  assert.notEqual(outcome, 'still pending');
  assert.match(outcome.message, /timed out/iu);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, 1);
});

test('update check permits streamless fallback only with a trustworthy bounded length', async () => {
  const valid = updateResponse({
    schemaVersion: 1,
    appId: 'ineed-mqtt-tool',
    releases: {},
  }, { stream: false });
  assert.equal((await checkForUpdates({ fetch: async () => valid })).available, false);
  assert.equal(valid.state.textCalls, 1);

  const missingLength = updateResponse({ success: true, data: {} }, {
    contentLength: null,
    stream: false,
  });
  await assert.rejects(
    () => checkForUpdates({ fetch: async () => missingLength }),
    /content-length/iu,
  );
  assert.equal(missingLength.state.textCalls, 0);
});

test('update check decodes UTF-8 characters split across stream chunks', async () => {
  const description = '修复说明';
  const body = JSON.stringify({
    schemaVersion: 1,
    appId: 'ineed-mqtt-tool',
    releases: {
      'electron-macos-arm64-dmg': { version: '0.1.1', url: 'https://example.com/app', description },
    },
  });
  const bytes = new TextEncoder().encode(body);
  const multibyteStart = bytes.findIndex(byte => byte >= 0xc0);
  const response = updateResponse(body, {
    chunks: [bytes.subarray(0, multibyteStart + 1), bytes.subarray(multibyteStart + 1)],
  });

  const result = await checkForUpdates({ platform: 'darwin', arch: 'arm64', currentVersion: '0.1.0', fetch: async () => response });
  assert.equal(result.description, description);
  assert.equal(response.state.textCalls, 0);
});

test('update check aborts a hung fetch at its finite timeout', async () => {
  let receivedSignal;
  const result = checkForUpdates({
    timeoutMs: 5,
    fetch: async (_url, options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(() => result, /timed out/iu);
  assert.equal(receivedSignal.aborted, true);
});
