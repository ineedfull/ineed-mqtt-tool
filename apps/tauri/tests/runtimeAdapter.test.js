import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  REQUIRED_RUNTIME_METHODS,
  assertRuntimeAdapter,
} from '@ineed-mqtt-tool/runtime-contract';

import { createTauriRuntimeAdapter } from '../renderer/runtimeAdapter.js';

const BINDINGS = new Map([
  ['connection.list', { command: 'db_get_connections', args: [] }],
  ['connection.save', { command: 'db_save_connection', args: [{ conn: { id: 'connection-1', host: 'broker.example' } }], callArgs: [{ id: 'connection-1', host: 'broker.example' }] }],
  ['connection.delete', { command: 'db_delete_connection', args: [{ id: 'connection-1' }], callArgs: ['connection-1'] }],
  ['connection.messageCounts', { command: 'db_get_message_counts', args: [] }],
  ['subscription.list', { command: 'db_get_subscriptions', args: [{ connId: 'connection-1' }], callArgs: ['connection-1'] }],
  ['subscription.add', { command: 'db_add_subscription', args: [{ sub: { id: 'subscription-1', topic: 'sensors/#' } }], callArgs: [{ id: 'subscription-1', topic: 'sensors/#' }] }],
  ['subscription.remove', { command: 'db_remove_subscription', args: [{ id: 'subscription-1' }], callArgs: ['subscription-1'] }],
  ['mqtt.connect', { command: 'mqtt_connect', args: [{ conn: { id: 'connection-1', port: 1883 } }], callArgs: [{ id: 'connection-1', port: 1883 }] }],
  ['mqtt.disconnect', { command: 'mqtt_disconnect', args: [{ connId: 'connection-1' }], callArgs: ['connection-1'] }],
  ['mqtt.subscribe', { command: 'mqtt_subscribe', args: [{ connId: 'connection-1', topic: 'sensors/#', qos: 1 }], callArgs: ['connection-1', 'sensors/#', 1] }],
  ['mqtt.unsubscribe', { command: 'mqtt_unsubscribe', args: [{ connId: 'connection-1', topic: 'sensors/#' }], callArgs: ['connection-1', 'sensors/#'] }],
  ['mqtt.publish', { command: 'mqtt_publish', args: [{ connId: 'connection-1', topic: 'commands/start', payload: 'go', qos: 2, retain: true }], callArgs: ['connection-1', 'commands/start', 'go', 2, true] }],
  ['mqtt.onMessages', { event: 'mqtt:messages' }],
  ['mqtt.onStatus', { event: 'mqtt:status' }],
  ['history.saveMessages', { command: 'db_save_messages', args: [{ rows: [{ id: 'message-1' }] }], callArgs: [[{ id: 'message-1' }]] }],
  ['history.saveLogs', { command: 'db_save_logs', args: [{ rows: [{ id: 'log-1' }] }], callArgs: [[{ id: 'log-1' }]] }],
  ['history.queryMessages', { command: 'db_query_history_messages', args: [{ filter: { connId: 'connection-1', page: 2 } }], callArgs: [{ connId: 'connection-1', page: 2 }] }],
  ['history.deleteMessage', { command: 'db_delete_history_message', args: [{ id: 17 }], callArgs: [17] }],
  ['history.clearMessages', { command: 'db_clear_history_messages', args: [{ filter: { connId: 'connection-1' } }], callArgs: [{ connId: 'connection-1' }] }],
  ['history.queryLogs', { command: 'db_query_history_logs', args: [{ filter: { connId: 'connection-1', level: 'warn' } }], callArgs: [{ connId: 'connection-1', level: 'warn' }] }],
  ['history.deleteLog', { command: 'db_delete_history_log', args: [{ id: 19 }], callArgs: [19] }],
  ['history.clearLogs', { command: 'db_clear_history_logs', args: [{ filter: { connId: 'connection-1' } }], callArgs: [{ connId: 'connection-1' }] }],
  ['publishHistory.list', { command: 'db_get_publish_history', args: [{ connId: 'connection-1', limit: 25 }], callArgs: ['connection-1', 25] }],
  ['publishHistory.save', { command: 'db_save_publish', args: [{ msg: { topic: 'commands/start', payload: 'go' } }], callArgs: [{ topic: 'commands/start', payload: 'go' }] }],
  ['settings.getAll', { command: 'db_get_all_settings', args: [] }],
  ['settings.save', { command: 'db_save_setting', args: [{ key: 'defaultQos', value: '2' }], callArgs: ['defaultQos', 2] }],
  ['storage.stats', { command: 'db_get_storage_stats', args: [] }],
  ['storage.clearHistory', { command: 'db_clear_history_storage', args: [] }],
  ['clipboard.readText', { clipboard: 'readText', callArgs: [] }],
  ['clipboard.writeText', { clipboard: 'writeText', callArgs: ['copied text'] }],
  ['window.openHistory', { command: 'window_open_history', args: [{ kind: 'messages', connId: 'connection-1' }], callArgs: ['messages', 'connection-1'] }],
  ['window.openExternal', { command: 'window_open_external', args: [{ url: 'https://downloads.example/app.zip' }], callArgs: ['https://downloads.example/app.zip'] }],
  ['lifecycle.onBeforeClose', { event: 'app:before-close' }],
  ['update.check', { command: 'update_check', args: [{}], callArgs: [] }],
]);

function ownValueAtPath(target, dottedPath) {
  return dottedPath.split('.').reduce(
    (value, key) => Object.getOwnPropertyDescriptor(value, key).value,
    target,
  );
}

function createHarness({ invokeImplementation, listenImplementation } = {}) {
  const calls = {
    invokes: [],
    listens: [],
    readText: [],
    unlistens: [],
    writeText: [],
  };
  const commandResults = new Map();
  const listeners = new Map();

  for (const binding of BINDINGS.values()) {
    if (binding.command) {
      commandResults.set(binding.command, Object.freeze({ command: binding.command }));
    }
  }

  const dependencies = {
    invoke(command, ...args) {
      calls.invokes.push({ args, command, receiver: this });
      if (invokeImplementation) {
        return invokeImplementation({ args, calls, command, commandResults });
      }
      return commandResults.get(command);
    },
    listen(event, handler) {
      calls.listens.push({ event, handler, receiver: this });
      listeners.set(event, handler);
      if (listenImplementation) {
        return listenImplementation({ calls, event, handler });
      }
      return Promise.resolve(async function nativeUnlisten() {
        calls.unlistens.push(event);
        return Object.freeze({ event, unlistened: true });
      });
    },
    readText() {
      calls.readText.push({ receiver: this });
      return Object.freeze({ clipboard: 'readText' });
    },
    writeText(value) {
      calls.writeText.push({ receiver: this, value });
      return Object.freeze({ clipboard: 'writeText' });
    },
  };

  return { calls, commandResults, dependencies, listeners };
}

test('creates a complete Tauri adapter for the current runtime contract', () => {
  assert.deepEqual([...BINDINGS.keys()], REQUIRED_RUNTIME_METHODS);

  const { dependencies } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);

  assert.equal(adapter.runtimeName, 'tauri');
  assert.equal(assertRuntimeAdapter(adapter), adapter);
});

test('maps every command method to the exact snake_case command and named arguments', () => {
  const { calls, commandResults, dependencies } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);

  for (const [adapterPath, binding] of BINDINGS) {
    if (!binding.command) continue;
    const result = ownValueAtPath(adapter, adapterPath)(...(binding.callArgs ?? []));
    const call = calls.invokes.at(-1);

    assert.equal(result, commandResults.get(binding.command), `${adapterPath} result`);
    assert.equal(call.command, binding.command, `${adapterPath} command`);
    assert.deepEqual(call.args, binding.args, `${adapterPath} named arguments`);
  }
});

test('maps clipboard methods directly and preserves their results', () => {
  const { calls, dependencies } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);

  assert.deepEqual(adapter.clipboard.readText(), { clipboard: 'readText' });
  assert.deepEqual(adapter.clipboard.writeText('copied text'), { clipboard: 'writeText' });
  assert.deepEqual(calls.readText, [{ receiver: dependencies }]);
  assert.deepEqual(calls.writeText, [{ receiver: dependencies, value: 'copied text' }]);
});

test('connect canonicalizes database aliases and preserves explicit cleared and disabled values', () => {
  for (const [input, expected] of [
    [{ id: 'edited', client_id: 'old', clientId: '', clean_session: 1, cleanSession: false, auto_reconnect: 1, autoReconnect: 0 },
      { id: 'edited', clientId: '', cleanSession: false, autoReconnect: 0 }],
    [{ id: 'saved', client_id: 'saved-id', clean_session: 0, auto_reconnect: false },
      { id: 'saved', clientId: 'saved-id', cleanSession: 0, autoReconnect: false }],
  ]) {
    const source = Object.freeze(input);
    const { calls, dependencies } = createHarness();
    createTauriRuntimeAdapter(dependencies).mqtt.connect(source);
    assert.deepEqual(calls.invokes.at(-1).args, [{ conn: expected }]);
    assert.deepEqual(source, input);
  }
});

test('converts Uint8Array publish payloads without mutating the source', () => {
  const { calls, commandResults, dependencies } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  const payload = Uint8Array.from([0, 127, 255]);

  const result = adapter.mqtt.publish('connection-1', 'binary/data', payload, 2, true);

  assert.equal(result, commandResults.get('mqtt_publish'));
  assert.deepEqual(calls.invokes.at(-1), {
    args: [{
      connId: 'connection-1',
      payload: [0, 127, 255],
      qos: 2,
      retain: true,
      topic: 'binary/data',
    }],
    command: 'mqtt_publish',
    receiver: dependencies,
  });
  assert.deepEqual(payload, Uint8Array.from([0, 127, 255]));
});

test('preserves publish strings and rejects unsupported payload containers before invoke', () => {
  const unsupportedPayloads = [
    [0, 255],
    new Uint16Array([0, 255]),
    new Int8Array([0, 127]),
    new Set([0, 255]),
    null,
    undefined,
  ];

  for (const payload of unsupportedPayloads) {
    const { calls, dependencies } = createHarness();
    const adapter = createTauriRuntimeAdapter(dependencies);

    assert.throws(
      () => adapter.mqtt.publish('connection-1', 'invalid/data', payload, 0, false),
      new TypeError('Tauri MQTT payload must be a string or Uint8Array'),
    );
    assert.deepEqual(calls.invokes, []);
  }

  const { calls, dependencies } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  adapter.mqtt.publish('connection-1', 'text/data', '中A', 1, false);
  assert.equal(calls.invokes.at(-1).args[0].payload, '中A');
});

test('normalizes Rust MQTT message batches and disposes the async listener exactly once', async () => {
  const { calls, dependencies, listeners } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  const received = [];
  const handlerResult = Object.freeze({ handled: 'messages' });

  const unsubscribe = adapter.mqtt.onMessages((batch) => {
    received.push(batch);
    return handlerResult;
  });
  const listener = listeners.get('mqtt:messages');
  const listenerResult = listener({
    payload: [{
      byteLength: 2,
      connId: 7,
      payload: '\ufffd',
      payloadHex: '00ff',
      qos: '1',
      retained: 1,
      time: '1970-01-01T00:00:00.042Z',
      topic: 8,
    }],
  });

  assert.equal(listenerResult, handlerResult);
  assert.deepEqual(received, [[{
    connId: '7',
    payload: Uint8Array.from([0, 255]),
    payloadText: '\ufffd',
    qos: 1,
    retained: true,
    timestamp: 42,
    topic: '8',
  }]]);
  assert.equal(calls.listens[0].event, 'mqtt:messages');
  assert.equal(calls.listens[0].receiver, dependencies);

  const firstDisposal = unsubscribe();
  const secondDisposal = unsubscribe();
  assert.equal(firstDisposal, secondDisposal);
  assert.deepEqual(await firstDisposal, { event: 'mqtt:messages', unlistened: true });
  assert.deepEqual(calls.unlistens, ['mqtt:messages']);
});

test('normalizes MQTT status and waits for pending Tauri unlisten', async () => {
  let resolveListen;
  const pendingListen = new Promise(resolve => {
    resolveListen = resolve;
  });
  const { calls, dependencies, listeners } = createHarness({
    listenImplementation: () => pendingListen,
  });
  const adapter = createTauriRuntimeAdapter(dependencies);
  const received = [];
  const handlerResult = Object.freeze({ handled: 'status' });
  const unsubscribe = adapter.mqtt.onStatus((status) => {
    received.push(status);
    return handlerResult;
  });
  const listener = listeners.get('mqtt:status');

  assert.equal(listener({ payload: {
    attempt: '3',
    code: 401,
    connId: 7,
    disconnectedAt: '1000',
    reason: 5,
    reconnected: 1,
    source: 'broker',
    status: 'connected',
  } }), handlerResult);
  assert.deepEqual(received, [{
    attempt: 3,
    code: '401',
    connId: '7',
    disconnectedAt: 1000,
    nextDelayMs: null,
    reason: '5',
    reconnected: true,
    source: 'broker',
    status: 'connected',
  }]);

  const disposal = unsubscribe();
  assert.deepEqual(calls.unlistens, []);
  resolveListen(() => {
    calls.unlistens.push('mqtt:status');
    return 'status-unlistened';
  });
  assert.equal(await disposal, 'status-unlistened');
  assert.deepEqual(calls.unlistens, ['mqtt:status']);
});

test('surfaces listen rejection and invalid unlisten values through the idempotent disposer', async () => {
  const listenFailure = new Error('event plugin denied listener');
  const rejectionHarness = createHarness({
    listenImplementation: () => Promise.reject(listenFailure),
  });
  const rejectionAdapter = createTauriRuntimeAdapter(rejectionHarness.dependencies);
  const rejectionDisposer = rejectionAdapter.mqtt.onMessages(() => {});
  const firstRejection = rejectionDisposer();
  const secondRejection = rejectionDisposer();

  assert.equal(firstRejection, secondRejection);
  await assert.rejects(firstRejection, listenFailure);

  const invalidHarness = createHarness({
    listenImplementation: () => Promise.resolve({ not: 'callable' }),
  });
  const invalidAdapter = createTauriRuntimeAdapter(invalidHarness.dependencies);
  await assert.rejects(
    invalidAdapter.mqtt.onStatus(() => {})(),
    new TypeError('Tauri listen("mqtt:status") must resolve to an unlisten function'),
  );
});

test('before-close awaits the handler and acknowledges success with the exact request id', async () => {
  const { calls, dependencies, listeners } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  const request = Object.freeze({ requestId: 'close-17' });
  const handlerCalls = [];
  let releaseHandler;
  const handlerBarrier = new Promise(resolve => {
    releaseHandler = resolve;
  });
  const dispose = adapter.lifecycle.onBeforeClose(async (...args) => {
    handlerCalls.push(args);
    await handlerBarrier;
  });
  const listener = listeners.get('app:before-close');

  const listenerResult = listener({ payload: request });
  assert.equal(typeof listenerResult?.then, 'function');
  assert.deepEqual(handlerCalls, [[request]]);
  assert.deepEqual(calls.invokes, []);

  releaseHandler();
  assert.equal(await listenerResult, undefined);
  assert.deepEqual(calls.invokes, [{
    args: [{ error: null, ok: true, requestId: 'close-17' }],
    command: 'window_close_ready',
    receiver: dependencies,
  }]);
  await dispose();
});

test('before-close claims request ids once across duplicates and re-registration', async () => {
  const { calls, dependencies, listeners } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  const handled = [];
  let releasePending;
  const pendingBarrier = new Promise(resolve => {
    releasePending = resolve;
  });
  const firstDispose = adapter.lifecycle.onBeforeClose(async (request) => {
    handled.push(request.requestId);
    if (request.requestId === 'close-pending') await pendingBarrier;
  });
  const firstListener = listeners.get('app:before-close');

  const pending = firstListener({ payload: { requestId: 'close-pending' } });
  const concurrentDuplicate = firstListener({ payload: { requestId: 'close-pending' } });
  await Promise.resolve();
  assert.deepEqual(handled, ['close-pending']);
  releasePending();
  await Promise.all([pending, concurrentDuplicate]);
  await firstListener({ payload: { requestId: 'close-pending' } });
  await firstListener({ payload: { requestId: 'close-two' } });
  assert.deepEqual(handled, ['close-pending', 'close-two']);
  assert.deepEqual(
    calls.invokes.map(call => call.args[0].requestId),
    ['close-pending', 'close-two'],
  );

  assert.throws(
    () => adapter.lifecycle.onBeforeClose(() => {}),
    new Error('before-close handler is already registered'),
  );
  const firstDisposal = firstDispose();
  assert.equal(firstDisposal, firstDispose());
  assert.throws(
    () => adapter.lifecycle.onBeforeClose(() => {}),
    new Error('before-close handler is already registered'),
  );
  await firstDisposal;

  const secondDispose = adapter.lifecycle.onBeforeClose(request => {
    handled.push(request.requestId);
  });
  const secondListener = listeners.get('app:before-close');
  await secondListener({ payload: { requestId: 'close-pending' } });
  await secondListener({ payload: { requestId: 'close-three' } });
  assert.deepEqual(handled, ['close-pending', 'close-two', 'close-three']);
  await secondDispose();
});

test('before-close ignores invalid ids, contains handler failures, and contains ack failures', async () => {
  const acknowledgeFailure = new Error('window already destroyed');
  const { calls, dependencies, listeners } = createHarness({
    invokeImplementation: ({ command, commandResults }) => {
      if (command === 'window_close_ready') return Promise.reject(acknowledgeFailure);
      return commandResults.get(command);
    },
  });
  const adapter = createTauriRuntimeAdapter(dependencies);
  const handlerCalls = [];
  const hostileRequest = {};
  Object.defineProperty(hostileRequest, 'requestId', {
    get() {
      throw new Error('request id getter failed');
    },
  });
  const invalidRequests = [
    undefined,
    null,
    {},
    { requestId: '' },
    { requestId: '   ' },
    { requestId: 17 },
    hostileRequest,
  ];
  const dispose = adapter.lifecycle.onBeforeClose((request) => {
    handlerCalls.push(request);
    throw Object.assign(new Error('flush failed'), { name: 'StorageFlushError' });
  });
  const listener = listeners.get('app:before-close');

  for (const request of invalidRequests) {
    assert.equal(await listener({ payload: request }), undefined);
  }
  assert.deepEqual(handlerCalls, []);
  assert.deepEqual(calls.invokes, []);

  assert.equal(await listener({ payload: { requestId: 'close-failure' } }), undefined);
  assert.equal(handlerCalls.length, 1);
  assert.deepEqual(calls.invokes, [{
    args: [{ error: 'flush failed', ok: false, requestId: 'close-failure' }],
    command: 'window_close_ready',
    receiver: dependencies,
  }]);
  await dispose();
});

test('before-close safely normalizes hostile rejected values', async () => {
  const hostileFailure = new Proxy({}, {
    get() {
      throw new Error('failure accessor must stay contained');
    },
  });
  const { calls, dependencies, listeners } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  const dispose = adapter.lifecycle.onBeforeClose(() => {
    throw hostileFailure;
  });

  assert.equal(
    await listeners.get('app:before-close')({ payload: { requestId: 'close-hostile' } }),
    undefined,
  );
  assert.deepEqual(calls.invokes[0].args[0], {
    error: 'Before-close handler failed',
    ok: false,
    requestId: 'close-hostile',
  });
  await dispose();
});

test('validates injected dependencies and event handlers without invoking accessors', () => {
  const { dependencies } = createHarness();
  const cases = [
    ['invoke', 'Tauri invoke must be a function'],
    ['listen', 'Tauri listen must be a function'],
    ['readText', 'Tauri clipboard readText must be a function'],
    ['writeText', 'Tauri clipboard writeText must be a function'],
  ];

  for (const [dependency, message] of cases) {
    assert.throws(
      () => createTauriRuntimeAdapter({ ...dependencies, [dependency]: null }),
      new TypeError(message),
    );
  }

  let getterCalls = 0;
  const accessorDependencies = { ...dependencies };
  Object.defineProperty(accessorDependencies, 'invoke', {
    get() {
      getterCalls += 1;
      throw new Error('dependency getter must not run');
    },
  });
  assert.throws(
    () => createTauriRuntimeAdapter(accessorDependencies),
    new TypeError('Tauri invoke must be a function'),
  );
  assert.equal(getterCalls, 0);

  const adapter = createTauriRuntimeAdapter(dependencies);
  for (const subscribe of [
    adapter.mqtt.onMessages,
    adapter.mqtt.onStatus,
    adapter.lifecycle.onBeforeClose,
  ]) {
    assert.throws(() => subscribe(null), new TypeError('event handler must be a function'));
  }
});

test('renderer boundary imports native APIs and injects them without Tauri globals', async () => {
  const [adapterSource, mainSource, manifestSource, lockSource] = await Promise.all([
    readFile(new URL('../renderer/runtimeAdapter.js', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource);
  const lockfile = JSON.parse(lockSource);

  assert.match(mainSource, /import \{ invoke \} from '@tauri-apps\/api\/core';/);
  assert.match(mainSource, /import \{ emit, listen \} from '@tauri-apps\/api\/event';/);
  assert.match(mainSource, /import \{ readText, writeText \} from '@tauri-apps\/plugin-clipboard-manager';/);
  assert.match(mainSource, /configureRendererReadiness/u);
  assert.match(mainSource, /invoke:\s*readiness\.invoke/u);
  assert.match(mainSource, /const app = createWorkbench\(adapter\)/u);
  assert.match(mainSource, /app\.mount\('#app'\)/u);
  assert.ok(
    mainSource.indexOf('readiness.configureVueApp(app') < mainSource.indexOf("app.mount('#app')"),
    'Vue error handler must be installed before mount',
  );
  assert.match(mainSource, /readiness\.markMounted\(document\.querySelector\('#app'\)\)/);
  assert.doesNotMatch(`${adapterSource}\n${mainSource}`, /__TAURI__|__TAURI_INTERNALS__|window\.ineedMqtt/);

  for (const dependency of [
    '@ineed-mqtt-tool/mqtt-contract',
    '@ineed-mqtt-tool/runtime-contract',
    '@ineed-mqtt-tool/workbench',
    '@tauri-apps/api',
    '@tauri-apps/plugin-clipboard-manager',
  ]) {
    assert.equal(typeof manifest.dependencies[dependency], 'string', dependency);
    assert.equal(
      typeof lockfile.packages['apps/tauri'].dependencies[dependency],
      'string',
      `${dependency} lockfile entry`,
    );
  }
  assert.equal(
    lockfile.packages['node_modules/@ineed-mqtt-tool/mqtt-contract'].resolved,
    'packages/mqtt-contract',
  );
});


test('update preparation ACK failures do not leak a rejected native listener', async () => {
  const { dependencies, listeners, calls } = createHarness({ invokeImplementation: ({ command }) => {
    if (command === 'update_prepare_ready') return Promise.reject(new Error('window gone'));
  } });
  const adapter = createTauriRuntimeAdapter(dependencies);
  adapter.lifecycle.onBeforeClose(async request => assert.equal(request.purpose, 'update'));
  await listeners.get('app:before-close')({ payload: { requestId: 'update-test', purpose: 'update' } });
  assert.equal(calls.invokes.at(-1).command, 'update_prepare_ready');
});


test('Tauri native history commit marker is preserved for the workbench', async () => {
  const { dependencies, listeners } = createHarness();
  const adapter = createTauriRuntimeAdapter(dependencies);
  let received;
  const dispose = adapter.mqtt.onMessages(batch => { received = batch; });
  listeners.get('mqtt:messages')({ payload: [{ connId: 'c', topic: 't', payload: 'x', payloadHex: '78', qos: 1, retained: false, time: '2026-10-13T00:00:00Z', historyPersisted: true }] });
  assert.equal(received[0].historyPersisted, true);
  await dispose();
});
