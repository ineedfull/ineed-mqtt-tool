import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  REQUIRED_RUNTIME_METHODS,
  assertRuntimeAdapter,
} from '@ineed-mqtt-tool/runtime-contract';

import { createElectronRuntimeAdapter } from '../renderer/runtimeAdapter.js';

const BRIDGE_METHODS = new Map([
  ['connection.list', 'db.getConnections'],
  ['connection.save', 'db.saveConnection'],
  ['connection.delete', 'db.deleteConnection'],
  ['connection.messageCounts', 'db.getMessageCounts'],
  ['subscription.list', 'db.getSubscriptions'],
  ['subscription.add', 'db.addSubscription'],
  ['subscription.remove', 'db.removeSubscription'],
  ['mqtt.connect', 'mqtt.connect'],
  ['mqtt.disconnect', 'mqtt.disconnect'],
  ['mqtt.subscribe', 'mqtt.subscribe'],
  ['mqtt.unsubscribe', 'mqtt.unsubscribe'],
  ['mqtt.publish', 'mqtt.publish'],
  ['mqtt.onMessages', 'mqtt.onMessages'],
  ['mqtt.onStatus', 'mqtt.onStatus'],
  ['history.saveMessages', 'db.saveMessages'],
  ['history.saveLogs', 'db.saveLogs'],
  ['history.queryMessages', 'db.queryHistoryMessages'],
  ['history.deleteMessage', 'db.deleteHistoryMessage'],
  ['history.clearMessages', 'db.clearHistoryMessages'],
  ['history.queryLogs', 'db.queryHistoryLogs'],
  ['history.deleteLog', 'db.deleteHistoryLog'],
  ['history.clearLogs', 'db.clearHistoryLogs'],
  ['publishHistory.list', 'db.getPublishHistory'],
  ['publishHistory.save', 'db.savePublish'],
  ['settings.getAll', 'db.getAllSettings'],
  ['settings.save', 'db.saveSetting'],
  ['storage.stats', 'db.getStorageStats'],
  ['storage.clearHistory', 'db.clearHistoryStorage'],
  ['clipboard.readText', 'clipboard.readText'],
  ['clipboard.writeText', 'clipboard.writeText'],
  ['window.openHistory', 'window.openHistory'],
  ['window.openExternal', 'window.openExternal'],
  ['lifecycle.onBeforeClose', 'lifecycle.onBeforeClose'],
  ['update.check', 'update.check'],
]);

const CALL_CASES = new Map([
  ['connection.list', []],
  ['connection.save', [{ id: 'connection-1', host: 'broker.example' }]],
  ['connection.delete', ['connection-1']],
  ['connection.messageCounts', []],
  ['subscription.list', ['connection-1']],
  ['subscription.add', [{ id: 'subscription-1', topic: 'sensors/#' }]],
  ['subscription.remove', ['subscription-1']],
  ['mqtt.connect', [{ id: 'connection-1', port: 1883 }]],
  ['mqtt.disconnect', ['connection-1']],
  ['mqtt.subscribe', ['connection-1', 'sensors/#', 1]],
  ['mqtt.unsubscribe', ['connection-1', 'sensors/#']],
  ['history.saveMessages', [[{ id: 'message-1' }]]],
  ['history.saveLogs', [[{ id: 'log-1' }]]],
  ['history.queryMessages', [{ connId: 'connection-1', page: 2 }]],
  ['history.deleteMessage', ['message-1']],
  ['history.clearMessages', [{ connId: 'connection-1' }]],
  ['history.queryLogs', [{ connId: 'connection-1', level: 'warn' }]],
  ['history.deleteLog', ['log-1']],
  ['history.clearLogs', [{ connId: 'connection-1' }]],
  ['publishHistory.list', ['connection-1', 25]],
  ['publishHistory.save', [{ topic: 'commands/start', payload: 'go' }]],
  ['settings.getAll', []],
  ['settings.save', ['defaultQos', 2]],
  ['storage.stats', []],
  ['storage.clearHistory', []],
  ['clipboard.readText', []],
  ['clipboard.writeText', ['copied text']],
  ['window.openHistory', ['messages', 'connection-1']],
  ['window.openExternal', ['https://downloads.example/app.zip']],
  ['update.check', []],
]);
const EVENT_BRIDGE_METHODS = new Set([
  'mqtt.onMessages',
  'mqtt.onStatus',
  'lifecycle.onBeforeClose',
]);

function ownValueAtPath(target, dottedPath) {
  return dottedPath.split('.').reduce(
    (value, key) => Object.getOwnPropertyDescriptor(value, key).value,
    target,
  );
}

function createFakeBridge() {
  const calls = [];
  const results = new Map();
  const listeners = new Map();
  const bridge = {
    runtime: 'electron',
    db: { namespace: 'db' },
    mqtt: { namespace: 'mqtt' },
    clipboard: { namespace: 'clipboard' },
    window: { namespace: 'window' },
    lifecycle: { namespace: 'lifecycle' },
    update: { namespace: 'update' },
  };

  for (const bridgePath of new Set(BRIDGE_METHODS.values())) {
    const [namespaceName, methodName] = bridgePath.split('.');
    const namespace = bridge[namespaceName];
    const result = EVENT_BRIDGE_METHODS.has(bridgePath)
      ? function nativeUnsubscribe() {}
      : Object.freeze({ bridgePath });
    results.set(bridgePath, result);

    namespace[methodName] = function bridgeMethod(...args) {
      calls.push({ args, bridgePath, receiver: this });
      if (EVENT_BRIDGE_METHODS.has(bridgePath)) {
        listeners.set(bridgePath, args[0]);
      }
      return result;
    };
  }

  return { bridge, calls, listeners, results };
}

test('creates a complete Electron adapter for the current runtime contract', () => {
  assert.deepEqual([...BRIDGE_METHODS.keys()], REQUIRED_RUNTIME_METHODS);

  const { bridge } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);

  assert.equal(adapter.runtimeName, 'electron');
  assert.equal(assertRuntimeAdapter(adapter), adapter);
});

test('maps every non-event method with its native receiver, exact arguments, and exact result', () => {
  const { bridge, calls, results } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);

  for (const [adapterPath, args] of CALL_CASES) {
    const bridgePath = BRIDGE_METHODS.get(adapterPath);
    const result = ownValueAtPath(adapter, adapterPath)(...args);
    const call = calls.at(-1);

    assert.equal(result, results.get(bridgePath), `${adapterPath} result`);
    assert.equal(call.bridgePath, bridgePath, `${adapterPath} bridge method`);
    assert.equal(call.receiver, ownValueAtPath(bridge, bridgePath.split('.')[0]), `${adapterPath} receiver`);
    assert.deepEqual(call.args, args, `${adapterPath} arguments`);
  }
});

test('converts publish Uint8Array payloads to plain number arrays', () => {
  const { bridge, calls, results } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);
  const payload = Uint8Array.from([0, 127, 255]);

  const result = adapter.mqtt.publish('connection-1', 'binary/data', payload, 2, true);

  assert.equal(result, results.get('mqtt.publish'));
  assert.deepEqual(calls.at(-1), {
    args: ['connection-1', 'binary/data', [0, 127, 255], 2, true],
    bridgePath: 'mqtt.publish',
    receiver: bridge.mqtt,
  });
  assert.deepEqual(payload, Uint8Array.from([0, 127, 255]));
});

test('preserves publish text payloads exactly, including Unicode', () => {
  const { bridge, calls, results } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);

  const result = adapter.mqtt.publish('connection-1', 'text/data', '中A', 1, false);

  assert.equal(result, results.get('mqtt.publish'));
  assert.deepEqual(calls.at(-1), {
    args: ['connection-1', 'text/data', '中A', 1, false],
    bridgePath: 'mqtt.publish',
    receiver: bridge.mqtt,
  });
});

test('rejects unsupported publish payload containers before calling the bridge', () => {
  const unsupportedPayloads = [
    [0, 255],
    [0, -1],
    [0, 256],
    [1.5],
    [Number.NaN],
    new Uint16Array([0, 255]),
    new Int8Array([0, 127]),
    new Set([0, 255]),
    null,
    undefined,
  ];

  for (const payload of unsupportedPayloads) {
    const { bridge, calls } = createFakeBridge();
    const adapter = createElectronRuntimeAdapter(bridge);

    assert.throws(
      () => adapter.mqtt.publish('connection-1', 'invalid/data', payload, 0, false),
      error => (
        error instanceof TypeError
        && error.message === 'Electron MQTT payload must be a string or Uint8Array'
      ),
    );
    assert.deepEqual(calls, []);
  }
});

test('normalizes message batches and returns the exact native unsubscriber', () => {
  const { bridge, calls, listeners, results } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);
  const received = [];
  const handlerResult = Object.freeze({ handled: 'messages' });

  const unsubscribe = adapter.mqtt.onMessages((batch) => {
    received.push(batch);
    return handlerResult;
  });
  const nativeListener = listeners.get('mqtt.onMessages');
  const listenerResult = nativeListener({
    connId: 7,
    topic: 8,
    payload: [0, 255],
    payloadText: 9,
    qos: '1',
    retained: 1,
    timestamp: '42',
  });

  assert.equal(unsubscribe, results.get('mqtt.onMessages'));
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(listenerResult, handlerResult);
  assert.deepEqual(received, [[{
    connId: '7',
    topic: '8',
    payload: Uint8Array.from([0, 255]),
    payloadText: '9',
    qos: 1,
    retained: true,
    timestamp: 42,
  }]]);
  assert.equal(calls[0].receiver, bridge.mqtt);
  assert.equal(calls[0].args[0], nativeListener);
});

test('normalizes MQTT status and returns the exact native unsubscriber', () => {
  const { bridge, calls, listeners, results } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);
  const received = [];
  const handlerResult = Object.freeze({ handled: 'status' });

  const unsubscribe = adapter.mqtt.onStatus((status) => {
    received.push(status);
    return handlerResult;
  });
  const nativeListener = listeners.get('mqtt.onStatus');
  const listenerResult = nativeListener({
    attempt: '3',
    code: 401,
    connId: 7,
    disconnectedAt: '1000',
    reason: 5,
    reconnected: 1,
    source: 'broker',
    status: 'connected',
  });

  assert.equal(unsubscribe, results.get('mqtt.onStatus'));
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(listenerResult, handlerResult);
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
  assert.equal(calls[0].receiver, bridge.mqtt);
  assert.equal(calls[0].args[0], nativeListener);
});

test('preserves before-close handler identity, async result, receiver, and unsubscriber', async () => {
  const { bridge, calls, listeners, results } = createFakeBridge();
  const adapter = createElectronRuntimeAdapter(bridge);
  const closeResult = Object.freeze({ persisted: true });
  const handlerCalls = [];
  const handler = async (...args) => {
    handlerCalls.push(args);
    return closeResult;
  };

  const unsubscribe = adapter.lifecycle.onBeforeClose(handler);
  const nativeListener = listeners.get('lifecycle.onBeforeClose');

  assert.equal(unsubscribe, results.get('lifecycle.onBeforeClose'));
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(nativeListener, handler);
  assert.equal(await nativeListener('close-request'), closeResult);
  assert.deepEqual(handlerCalls, [['close-request']]);
  assert.equal(calls[0].receiver, bridge.lifecycle);
  assert.deepEqual(calls[0].args, [handler]);
});

test('rejects invalid and incomplete preload bridges during construction', () => {
  assert.throws(() => createElectronRuntimeAdapter(null), TypeError);
  assert.throws(() => createElectronRuntimeAdapter({}), TypeError);

  const { bridge } = createFakeBridge();
  delete bridge.db.getConnections;

  assert.throws(
    () => createElectronRuntimeAdapter(bridge),
    error => error instanceof TypeError && /db\.getConnections/.test(error.message),
  );
});

test('bridge validation never invokes namespace or method getters', () => {
  let namespaceGetterCalls = 0;
  const namespaceAccessorBridge = {};
  Object.defineProperty(namespaceAccessorBridge, 'db', {
    get() {
      namespaceGetterCalls += 1;
      throw new Error('namespace getter must not run');
    },
  });

  assert.throws(() => createElectronRuntimeAdapter(namespaceAccessorBridge), TypeError);
  assert.equal(namespaceGetterCalls, 0);

  let methodGetterCalls = 0;
  const { bridge } = createFakeBridge();
  Object.defineProperty(bridge.mqtt, 'publish', {
    configurable: true,
    get() {
      methodGetterCalls += 1;
      throw new Error('method getter must not run');
    },
  });

  assert.throws(
    () => createElectronRuntimeAdapter(bridge),
    error => error instanceof TypeError && /mqtt\.publish/.test(error.message),
  );
  assert.equal(methodGetterCalls, 0);
});

test('adapter module contains no Proxy or native renderer global access', async () => {
  const source = await readFile(new URL('../renderer/runtimeAdapter.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\b(?:Proxy|globalThis|document|navigator)\b|window\.ineedMqtt/);
});


test('optional updater methods ignore getters and capture native receivers', async () => {
  const { bridge } = createFakeBridge();
  let reads = 0;
  Object.defineProperty(bridge.update, 'getState', { get() { reads++; throw new Error('getter'); } });
  bridge.update.download = function () { assert.equal(this, bridge.update); return 'downloaded'; };
  const adapter = createElectronRuntimeAdapter(bridge);
  assert.deepEqual(await adapter.update.getState(), { phase: 'idle', supported: false });
  bridge.update.download = () => { throw new Error('mutated'); };
  assert.equal(await adapter.update.download(), 'downloaded');
  assert.equal(reads, 0);
});
