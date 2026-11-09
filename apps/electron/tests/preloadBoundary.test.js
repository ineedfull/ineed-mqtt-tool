import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const INVOKE_CASES = Object.freeze([
  ['db.getConnections', 'db:get-connections', []],
  ['db.saveConnection', 'db:save-connection', [{ id: 'connection-1' }]],
  ['db.deleteConnection', 'db:delete-connection', ['connection-1']],
  ['db.getMessageCounts', 'db:get-message-counts', []],
  ['db.getSubscriptions', 'db:get-subscriptions', ['connection-1']],
  ['db.addSubscription', 'db:add-subscription', [{ id: 'subscription-1' }]],
  ['db.removeSubscription', 'db:remove-subscription', ['subscription-1']],
  ['mqtt.connect', 'mqtt:connect', [{ id: 'connection-1', port: 1883 }]],
  ['mqtt.disconnect', 'mqtt:disconnect', ['connection-1']],
  ['mqtt.subscribe', 'mqtt:subscribe', ['connection-1', 'sensors/#', 1]],
  ['mqtt.unsubscribe', 'mqtt:unsubscribe', ['connection-1', 'sensors/#']],
  ['mqtt.publish', 'mqtt:publish', ['connection-1', 'commands/start', [0, 255], 2, true]],
  ['db.saveMessages', 'db:save-messages', [[{ id: 'message-1' }]]],
  ['db.saveLogs', 'db:save-logs', [[{ id: 'log-1' }]]],
  ['db.queryHistoryMessages', 'db:query-history-messages', [{ page: 2 }]],
  ['db.deleteHistoryMessage', 'db:delete-history-message', ['message-1']],
  ['db.clearHistoryMessages', 'db:clear-history-messages', [{ connId: 'connection-1' }]],
  ['db.queryHistoryLogs', 'db:query-history-logs', [{ level: 'warn' }]],
  ['db.deleteHistoryLog', 'db:delete-history-log', ['log-1']],
  ['db.clearHistoryLogs', 'db:clear-history-logs', [{ connId: 'connection-1' }]],
  ['db.getPublishHistory', 'db:get-publish-history', ['connection-1', 25]],
  ['db.savePublish', 'db:save-publish', [{ topic: 'commands/start' }]],
  ['db.getAllSettings', 'db:get-all-settings', []],
  ['db.saveSetting', 'db:save-setting', ['defaultQos', 2]],
  ['db.getStorageStats', 'db:get-storage-stats', []],
  ['db.clearHistoryStorage', 'db:clear-history-storage', []],
  ['clipboard.readText', 'clipboard:read-text', []],
  ['clipboard.writeText', 'clipboard:write-text', ['copied text']],
  ['window.openHistory', 'window:open-history', ['messages', 'connection-1']],
  ['window.openExternal', 'window:open-external', ['https://downloads.example/app.zip']],
  ['update.check', 'update:check', []],
  ['update.getState', 'update:state', []],
  ['update.download', 'update:download', []],
  ['update.cancel', 'update:cancel', []],
  ['update.install', 'update:install', []],
]);

const APPROVED_IPC_CHANNELS = Object.freeze([
  'db:get-connections',
  'db:save-connection',
  'db:delete-connection',
  'db:get-message-counts',
  'db:get-subscriptions',
  'db:add-subscription',
  'db:remove-subscription',
  'db:save-messages',
  'db:save-logs',
  'db:query-history-messages',
  'db:delete-history-message',
  'db:clear-history-messages',
  'db:query-history-logs',
  'db:delete-history-log',
  'db:clear-history-logs',
  'db:get-publish-history',
  'db:save-publish',
  'db:get-all-settings',
  'db:save-setting',
  'db:get-storage-stats',
  'db:clear-history-storage',
  'mqtt:connect',
  'mqtt:disconnect',
  'mqtt:subscribe',
  'mqtt:unsubscribe',
  'mqtt:publish',
  'mqtt:messages',
  'mqtt:status',
  'clipboard:read-text',
  'clipboard:write-text',
  'window:open-history',
  'window:open-external',
  'lifecycle:before-close',
  'lifecycle:before-close-ack',
  'update:check',
  'update:state',
  'update:download',
  'update:cancel',
  'update:install',
  'update:changed',
]);

const EXPECTED_API_KEYS = Object.freeze({
  root: ['runtime', 'db', 'mqtt', 'clipboard', 'window', 'lifecycle', 'update'],
  db: [
    'getConnections',
    'saveConnection',
    'deleteConnection',
    'getMessageCounts',
    'getSubscriptions',
    'addSubscription',
    'removeSubscription',
    'saveMessages',
    'saveLogs',
    'queryHistoryMessages',
    'deleteHistoryMessage',
    'clearHistoryMessages',
    'queryHistoryLogs',
    'deleteHistoryLog',
    'clearHistoryLogs',
    'getPublishHistory',
    'savePublish',
    'getAllSettings',
    'saveSetting',
    'getStorageStats',
    'clearHistoryStorage',
  ],
  mqtt: ['connect', 'disconnect', 'subscribe', 'unsubscribe', 'publish', 'onMessages', 'onStatus'],
  clipboard: ['readText', 'writeText'],
  window: ['openHistory', 'openExternal'],
  lifecycle: ['onBeforeClose'],
  update: ['check', 'getState', 'download', 'cancel', 'install', 'onState'],
});

function valueAtPath(target, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value[key], target);
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function declaredIpcChannels(source) {
  const declaration = source.match(
    /const IPC_CHANNELS = Object\.freeze\(\{(?<body>[\s\S]*?)\n\}\);/,
  );

  assert.ok(declaration?.groups?.body, 'explicit IPC_CHANNELS declaration');
  return [...declaration.groups.body.matchAll(/:\s*'([^']+)'/g)]
    .map(([, channel]) => channel);
}

async function executePreload({ sendImplementation } = {}) {
  const source = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const calls = {
    electronPropertyReads: [],
    exposes: [],
    invokes: [],
    on: [],
    removes: [],
    requires: [],
    sends: [],
  };
  const invokeResults = new Map();
  const contextBridge = {
    exposeInMainWorld(name, api) {
      calls.exposes.push({ api, name, receiver: this });
    },
  };
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.invokes.push({ args, channel, receiver: this });
      const result = Object.freeze({ channel, invocation: calls.invokes.length });
      invokeResults.set(channel, result);
      return result;
    },
    on(channel, listener) {
      calls.on.push({ channel, listener, receiver: this });
      return this;
    },
    removeListener(channel, listener) {
      calls.removes.push({ channel, listener, receiver: this });
      return this;
    },
    send(channel, payload) {
      calls.sends.push({ channel, payload, receiver: this });
      return sendImplementation?.call(this, channel, payload);
    },
  };
  const electron = new Proxy({ contextBridge, ipcRenderer }, {
    get(target, property, receiver) {
      calls.electronPropertyReads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  const context = vm.createContext({
    require(specifier) {
      calls.requires.push(specifier);
      assert.equal(specifier, 'electron');
      return electron;
    },
  });

  new vm.Script(source, { filename: 'preload.cjs' }).runInContext(context);

  assert.equal(calls.exposes.length, 1);
  return {
    api: calls.exposes[0].api,
    calls,
    contextBridge,
    invokeResults,
    ipcRenderer,
    source,
  };
}

test('requires only the two sandbox-supported Electron capabilities and exposes one frozen exact bridge', async () => {
  const { api, calls, contextBridge, source } = await executePreload();

  assert.deepEqual(calls.requires, ['electron']);
  assert.deepEqual(
    calls.electronPropertyReads.toSorted(),
    ['contextBridge', 'ipcRenderer'],
  );
  assert.deepEqual(calls.exposes.map(({ name }) => name), ['ineedMqtt']);
  assert.deepEqual(declaredIpcChannels(source), APPROVED_IPC_CHANNELS);
  assert.equal(calls.exposes[0].receiver, contextBridge);
  assert.equal(api.runtime, 'electron');
  assert.deepEqual(Object.keys(api), EXPECTED_API_KEYS.root);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(
    Object.entries(EXPECTED_API_KEYS)
      .filter(([namespace]) => namespace !== 'root')
      .reduce((count, [, keys]) => count + keys.length, 0),
    39,
  );

  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(api))) {
    assert.equal(Object.hasOwn(descriptor, 'value'), true, 'root data property');
  }

  for (const [namespace, keys] of Object.entries(EXPECTED_API_KEYS)) {
    if (namespace === 'root') continue;
    assert.deepEqual(Object.keys(api[namespace]), keys, `${namespace} keys`);
    assert.equal(Object.isFrozen(api[namespace]), true, `${namespace} frozen`);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(api[namespace]))) {
      assert.equal(Object.hasOwn(descriptor, 'value'), true, `${namespace} data property`);
    }
  }

  assert.doesNotMatch(source, /contextIsolation\s*:\s*false|nodeIntegration\s*:\s*true/);
  for (const forbidden of ['send', 'invoke', 'on', 'removeListener', 'ipcRenderer']) {
    assert.equal(forbidden in api, false, `root does not expose ${forbidden}`);
    for (const namespace of EXPECTED_API_KEYS.root.slice(1)) {
      assert.equal(forbidden in api[namespace], false, `${namespace} does not expose ${forbidden}`);
    }
  }
});

test('maps every mutation and read wrapper to its one approved invoke channel with exact arguments', async () => {
  const { api, calls, invokeResults, ipcRenderer } = await executePreload();

  for (const [methodPath, channel, args] of INVOKE_CASES) {
    const result = valueAtPath(api, methodPath)(...args);
    const call = calls.invokes.at(-1);

    assert.equal(result, invokeResults.get(channel), `${methodPath} result`);
    assert.equal(call.channel, channel, `${methodPath} channel`);
    assert.equal(call.receiver, ipcRenderer, `${methodPath} receiver`);
    assert.deepEqual(call.args, args, `${methodPath} arguments`);
  }

  assert.deepEqual(
    calls.invokes.map(({ channel }) => channel),
    INVOKE_CASES.map(([, channel]) => channel),
  );
  assert.deepEqual(calls.on, []);
  assert.deepEqual(calls.sends, []);
});

test('normalizes clipboard writes and delegates through IPC without a preload clipboard module', async () => {
  const { api, calls, invokeResults } = await executePreload();
  for (const [value, text] of [[42, '42'], [null, ''], [undefined, '']]) {
    assert.equal(api.clipboard.writeText(value), invokeResults.get('clipboard:write-text'));
    assert.deepEqual(calls.invokes.at(-1).args, [text]);
    assert.equal(calls.invokes.at(-1).channel, 'clipboard:write-text');
  }
  assert.deepEqual(calls.sends, []);
});

for (const [methodPath, channel] of [
  ['mqtt.onMessages', 'mqtt:messages'],
  ['mqtt.onStatus', 'mqtt:status'],
]) {
  test(`${methodPath} forwards payload only and removes the exact wrapped listener once`, async () => {
    const { api, calls, ipcRenderer } = await executePreload();
    const payload = Object.freeze({ connId: 'connection-1', channel });
    const handlerCalls = [];
    const handlerResult = Object.freeze({ accepted: channel });
    const dispose = valueAtPath(api, methodPath)((...args) => {
      handlerCalls.push(args);
      return handlerResult;
    });

    assert.equal(typeof dispose, 'function');
    assert.equal(calls.on.length, 1);
    assert.equal(calls.on[0].channel, channel);
    assert.equal(calls.on[0].receiver, ipcRenderer);
    const wrappedListener = calls.on[0].listener;
    assert.equal(wrappedListener(Object.freeze({ sender: 'main' }), payload), handlerResult);
    assert.deepEqual(handlerCalls, [[payload]]);

    assert.equal(dispose(), undefined);
    assert.equal(dispose(), undefined);
    assert.deepEqual(calls.removes, [{
      channel,
      listener: wrappedListener,
      receiver: ipcRenderer,
    }]);
  });
}

test('before-close awaits the handler and acknowledges success by request id', async () => {
  const { api, calls, ipcRenderer } = await executePreload();
  const request = Object.freeze({ reason: 'native-window-close', requestId: 'close-17' });
  const handlerCalls = [];
  let releaseHandler;
  const handlerBarrier = new Promise(resolve => {
    releaseHandler = resolve;
  });
  const dispose = api.lifecycle.onBeforeClose(async (...args) => {
    handlerCalls.push(args);
    await handlerBarrier;
  });
  const registration = calls.on[0];

  assert.equal(registration.channel, 'lifecycle:before-close');
  assert.equal(registration.receiver, ipcRenderer);
  const listenerResult = registration.listener(Object.freeze({ sender: 'main' }), request);
  assert.equal(typeof listenerResult?.then, 'function');
  assert.deepEqual(handlerCalls, [[request]]);
  assert.deepEqual(calls.sends, []);

  releaseHandler();
  assert.equal(await listenerResult, undefined);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].channel, 'lifecycle:before-close-ack');
  assert.equal(calls.sends[0].receiver, ipcRenderer);
  assert.deepEqual(jsonValue(calls.sends[0].payload), {
    requestId: 'close-17',
    ok: true,
  });

  assert.equal(dispose(), undefined);
  assert.equal(dispose(), undefined);
  assert.deepEqual(calls.removes, [{
    channel: 'lifecycle:before-close',
    listener: registration.listener,
    receiver: ipcRenderer,
  }]);
});

test('before-close contains thrown and rejected handlers and acknowledges structured failures', async () => {
  const cases = [
    ['throw', error => () => { throw error; }],
    ['reject', error => () => Promise.reject(error)],
  ];

  for (const [kind, createHandler] of cases) {
    const { api, calls } = await executePreload();
    const failure = Object.assign(new Error('flush failed'), { name: 'StorageFlushError' });
    const dispose = api.lifecycle.onBeforeClose(createHandler(failure));
    const registration = calls.on[0];

    assert.equal(
      await registration.listener({}, { requestId: kind }),
      undefined,
      `native event listener must contain handler ${kind}`,
    );
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0].channel, 'lifecycle:before-close-ack');
    assert.deepEqual(jsonValue(calls.sends[0].payload), {
      error: {
        message: 'flush failed',
        name: 'StorageFlushError',
      },
      requestId: kind,
      ok: false,
    });
    assert.equal(dispose(), undefined);
  }
});

test('before-close permits one active handler and safely re-registers after exact disposal', async () => {
  const { api, calls, ipcRenderer } = await executePreload();
  const firstDispose = api.lifecycle.onBeforeClose(() => {});
  const firstRegistration = calls.on[0];

  assert.throws(
    () => api.lifecycle.onBeforeClose(() => {}),
    error => (
      error?.name === 'Error'
      && error.message === 'before-close handler is already registered'
    ),
  );
  assert.equal(calls.on.length, 1);

  assert.equal(firstDispose(), undefined);
  assert.equal(firstDispose(), undefined);
  assert.deepEqual(calls.removes, [{
    channel: 'lifecycle:before-close',
    listener: firstRegistration.listener,
    receiver: ipcRenderer,
  }]);

  const secondDispose = api.lifecycle.onBeforeClose(() => {});
  const secondRegistration = calls.on[1];
  assert.notEqual(secondRegistration.listener, firstRegistration.listener);
  assert.equal(firstDispose(), undefined, 'stale disposer remains harmless');
  assert.throws(
    () => api.lifecycle.onBeforeClose(() => {}),
    error => error?.message === 'before-close handler is already registered',
  );

  assert.equal(secondDispose(), undefined);
  assert.equal(secondDispose(), undefined);
  assert.deepEqual(calls.removes[1], {
    channel: 'lifecycle:before-close',
    listener: secondRegistration.listener,
    receiver: ipcRenderer,
  });
  assert.equal(calls.removes.length, 2);
});

test('before-close handles each valid request id once across duplicates and re-registration', async () => {
  const { api, calls } = await executePreload();
  const handlerRequestIds = [];
  let releasePending;
  const pendingBarrier = new Promise(resolve => {
    releasePending = resolve;
  });
  const firstDispose = api.lifecycle.onBeforeClose(async (request) => {
    handlerRequestIds.push(request.requestId);
    if (request.requestId === 'close-pending') await pendingBarrier;
  });
  const firstListener = calls.on[0].listener;

  const pending = firstListener({}, { requestId: 'close-pending' });
  const concurrentDuplicate = firstListener({}, { requestId: 'close-pending' });
  try {
    await Promise.resolve();
    assert.deepEqual(handlerRequestIds, ['close-pending']);
    assert.deepEqual(calls.sends, []);
  } finally {
    releasePending();
  }
  assert.equal(await concurrentDuplicate, undefined);
  assert.equal(await pending, undefined);
  assert.equal(await firstListener({}, { requestId: 'close-pending' }), undefined);
  assert.equal(await firstListener({}, { requestId: 'close-two' }), undefined);
  assert.equal(await firstListener({}, { requestId: 'close-three' }), undefined);
  assert.deepEqual(handlerRequestIds, ['close-pending', 'close-two', 'close-three']);
  assert.deepEqual(
    calls.sends.map(({ payload }) => jsonValue(payload)),
    [
      { requestId: 'close-pending', ok: true },
      { requestId: 'close-two', ok: true },
      { requestId: 'close-three', ok: true },
    ],
  );

  firstDispose();
  const secondHandlerRequestIds = [];
  const secondDispose = api.lifecycle.onBeforeClose((request) => {
    secondHandlerRequestIds.push(request.requestId);
  });
  const secondListener = calls.on[1].listener;

  assert.equal(await secondListener({}, { requestId: 'close-pending' }), undefined);
  assert.equal(await secondListener({}, { requestId: 'close-four' }), undefined);
  assert.deepEqual(secondHandlerRequestIds, ['close-four']);
  assert.deepEqual(
    calls.sends.map(({ payload }) => jsonValue(payload)),
    [
      { requestId: 'close-pending', ok: true },
      { requestId: 'close-two', ok: true },
      { requestId: 'close-three', ok: true },
      { requestId: 'close-four', ok: true },
    ],
  );
  secondDispose();
});

test('before-close contains invalid and hostile request ids without handler or ack', async () => {
  const { api, calls } = await executePreload();
  const handlerCalls = [];
  const dispose = api.lifecycle.onBeforeClose((request) => {
    handlerCalls.push(request);
  });
  const listener = calls.on[0].listener;
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
    { requestId: {} },
    { requestId: new String('boxed') },
    { requestId: Symbol('close') },
    hostileRequest,
  ];

  for (const request of invalidRequests) {
    assert.equal(await listener({}, request), undefined);
  }
  assert.deepEqual(handlerCalls, []);
  assert.deepEqual(calls.sends, []);
  dispose();
});

test('before-close contains hostile rejection values and failed ack sends exactly once', async () => {
  const hostileFailure = new Proxy({}, {
    get() {
      throw new Error('failure accessor must stay contained');
    },
  });
  const hostileHarness = await executePreload();
  const hostileDispose = hostileHarness.api.lifecycle.onBeforeClose(() => {
    throw hostileFailure;
  });
  const hostileListener = hostileHarness.calls.on[0].listener;

  assert.equal(await hostileListener({}, { requestId: 'close-hostile' }), undefined);
  assert.deepEqual(jsonValue(hostileHarness.calls.sends[0].payload), {
    error: {
      name: 'Error',
      message: 'Before-close handler failed',
    },
    requestId: 'close-hostile',
    ok: false,
  });
  hostileDispose();

  let sendAttempts = 0;
  const sendFailureHarness = await executePreload({
    sendImplementation() {
      sendAttempts += 1;
      throw new Error('renderer destroyed');
    },
  });
  let handlerCalls = 0;
  const sendFailureDispose = sendFailureHarness.api.lifecycle.onBeforeClose(() => {
    handlerCalls += 1;
  });
  const sendFailureListener = sendFailureHarness.calls.on[0].listener;

  assert.equal(await sendFailureListener({}, { requestId: 'close-send-failure' }), undefined);
  assert.equal(await sendFailureListener({}, { requestId: 'close-send-failure' }), undefined);
  assert.equal(handlerCalls, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(sendFailureHarness.calls.sends.length, 1);
  sendFailureDispose();
});

test('event APIs reject non-functions without registering native listeners', async () => {
  for (const methodPath of ['mqtt.onMessages', 'mqtt.onStatus', 'lifecycle.onBeforeClose']) {
    const { api, calls } = await executePreload();

    assert.throws(
      () => valueAtPath(api, methodPath)(null),
      error => error?.name === 'TypeError' && /handler must be a function/.test(error.message),
    );
    assert.deepEqual(calls.on, []);
  }
});
