import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_RUNTIME_METHODS,
  RuntimeUnavailableError,
  assertRuntimeAdapter,
  createUnavailableRuntimeAdapter,
} from '../src/index.js';

const EXPECTED_METHODS = [
  'connection.list',
  'connection.save',
  'connection.delete',
  'connection.messageCounts',
  'subscription.list',
  'subscription.add',
  'subscription.remove',
  'mqtt.connect',
  'mqtt.disconnect',
  'mqtt.subscribe',
  'mqtt.unsubscribe',
  'mqtt.publish',
  'mqtt.onMessages',
  'mqtt.onStatus',
  'history.saveMessages',
  'history.saveLogs',
  'history.queryMessages',
  'history.deleteMessage',
  'history.clearMessages',
  'history.queryLogs',
  'history.deleteLog',
  'history.clearLogs',
  'publishHistory.list',
  'publishHistory.save',
  'settings.getAll',
  'settings.save',
  'storage.stats',
  'storage.clearHistory',
  'clipboard.readText',
  'clipboard.writeText',
  'window.openHistory',
  'window.openExternal',
  'lifecycle.onBeforeClose',
  'update.check',
];

const REJECTING_METHODS = EXPECTED_METHODS.filter(
  (method) =>
    ![
      'connection.list',
      'connection.messageCounts',
      'subscription.list',
      'mqtt.onMessages',
      'mqtt.onStatus',
      'lifecycle.onBeforeClose',
      'history.queryMessages',
      'history.queryLogs',
      'publishHistory.list',
      'settings.getAll',
      'storage.stats',
      'clipboard.readText',
    ].includes(method),
);

function methodAt(adapter, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value[key], adapter);
}

test('required runtime methods have the exact immutable public order', () => {
  assert.deepEqual(REQUIRED_RUNTIME_METHODS, EXPECTED_METHODS);
  assert.equal(Object.isFrozen(REQUIRED_RUNTIME_METHODS), true);
  assert.throws(() => REQUIRED_RUNTIME_METHODS.push('extra.method'), TypeError);
});

test('an unavailable adapter is complete and carries a nonblank runtime name', () => {
  const adapter = createUnavailableRuntimeAdapter('test');

  assert.equal(assertRuntimeAdapter(adapter), adapter);
  assert.equal(typeof adapter.runtimeName, 'string');
  assert.notEqual(adapter.runtimeName.trim(), '');
});

test('assertRuntimeAdapter reports one missing method', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  delete adapter.mqtt.publish;

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError('Runtime adapter is missing required methods: mqtt.publish'),
  );
});

test('assertRuntimeAdapter reports multiple invalid methods in contract order', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  adapter.connection.save = null;
  delete adapter.mqtt.connect;
  delete adapter.history.clearLogs;

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError(
      'Runtime adapter is missing required methods: connection.save, mqtt.connect, history.clearLogs',
    ),
  );
});

test('assertRuntimeAdapter reports every method for a null adapter', () => {
  assert.throws(
    () => assertRuntimeAdapter(null),
    new TypeError(
      `Runtime adapter is missing required methods: ${EXPECTED_METHODS.join(', ')}`,
    ),
  );
});

test('assertRuntimeAdapter rejects a missing runtime name after method validation', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  delete adapter.runtimeName;

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError('Runtime adapter must have a nonblank own data runtimeName'),
  );
});

test('assertRuntimeAdapter rejects blank and non-string runtime names', () => {
  for (const runtimeName of ['', '   ', '\n\t', null, 42]) {
    const adapter = createUnavailableRuntimeAdapter('test');
    adapter.runtimeName = runtimeName;

    assert.throws(
      () => assertRuntimeAdapter(adapter),
      new TypeError('Runtime adapter must have a nonblank own data runtimeName'),
    );
  }
});

test('assertRuntimeAdapter rejects an inherited runtime name', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  delete adapter.runtimeName;
  Object.setPrototypeOf(adapter, { runtimeName: 'inherited' });

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError('Runtime adapter must have a nonblank own data runtimeName'),
  );
});

test('assertRuntimeAdapter rejects a runtime name accessor without invoking it', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  let getterCalls = 0;
  Object.defineProperty(adapter, 'runtimeName', {
    configurable: true,
    get() {
      getterCalls += 1;
      return 'accessor';
    },
  });

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError('Runtime adapter must have a nonblank own data runtimeName'),
  );
  assert.equal(getterCalls, 0);
});

test('assertRuntimeAdapter reports missing methods before an invalid runtime name', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  delete adapter.runtimeName;
  delete adapter.mqtt.publish;

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError('Runtime adapter is missing required methods: mqtt.publish'),
  );
});

test('assertRuntimeAdapter does not invoke nonthrowing namespace getters', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  let getterCalls = 0;
  Object.defineProperty(adapter, 'connection', {
    configurable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError(
      'Runtime adapter is missing required methods: connection.list, connection.save, connection.delete, connection.messageCounts',
    ),
  );
  assert.equal(getterCalls, 0);
});

test('assertRuntimeAdapter does not invoke throwing namespace getters', () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  let getterCalls = 0;
  Object.defineProperty(adapter, 'mqtt', {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('getter must not execute');
    },
  });

  assert.throws(
    () => assertRuntimeAdapter(adapter),
    new TypeError(
      'Runtime adapter is missing required methods: mqtt.connect, mqtt.disconnect, mqtt.subscribe, mqtt.unsubscribe, mqtt.publish, mqtt.onMessages, mqtt.onStatus',
    ),
  );
  assert.equal(getterCalls, 0);
});

test('assertRuntimeAdapter does not accept inherited methods', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'list');
  const adapter = createUnavailableRuntimeAdapter('test');
  delete adapter.connection.list;

  try {
    Object.defineProperty(Object.prototype, 'list', {
      configurable: true,
      value: () => [],
    });

    assert.throws(
      () => assertRuntimeAdapter(adapter),
      new TypeError('Runtime adapter is missing required methods: connection.list'),
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(Object.prototype, 'list', originalDescriptor);
    } else {
      delete Object.prototype.list;
    }
  }
});

test('unavailable adapter construction ignores polluted inherited namespaces', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'connection',
  );
  const pollutedNamespace = { marker: 'unchanged' };

  try {
    Object.defineProperty(Object.prototype, 'connection', {
      configurable: true,
      value: pollutedNamespace,
    });

    const adapter = createUnavailableRuntimeAdapter('test');
    assert.equal(Object.hasOwn(adapter, 'connection'), true);
    assert.notEqual(adapter.connection, pollutedNamespace);
    assert.equal(Object.getPrototypeOf(adapter.connection), null);
    assert.deepEqual(pollutedNamespace, { marker: 'unchanged' });
    assert.equal(typeof adapter.connection.list, 'function');
    assert.equal(Object.hasOwn(adapter.connection, 'list'), true);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(Object.prototype, 'connection', originalDescriptor);
    } else {
      delete Object.prototype.connection;
    }
  }
});

test('createUnavailableRuntimeAdapter rejects blank runtime names', () => {
  for (const runtimeName of ['', '   ', '\n\t']) {
    assert.throws(
      () => createUnavailableRuntimeAdapter(runtimeName),
      new TypeError('runtimeName must be a nonblank string'),
    );
  }
});

test('unavailable mutating and native methods reject with method context', async () => {
  const adapter = createUnavailableRuntimeAdapter('test');

  for (const method of REJECTING_METHODS) {
    await assert.rejects(methodAt(adapter, method)(), (error) => {
      assert.equal(error instanceof RuntimeUnavailableError, true);
      assert.equal(error.name, 'RuntimeUnavailableError');
      assert.equal(error.code, 'RUNTIME_METHOD_UNAVAILABLE');
      assert.equal(error.method, method);
      assert.equal(error.runtimeName, 'test');
      assert.equal(error.message, `Runtime method "${method}" is unavailable in test`);
      return true;
    });
  }
});

test('unavailable event methods return synchronous no-op unsubscriptions', () => {
  const adapter = createUnavailableRuntimeAdapter('test');

  for (const method of ['mqtt.onMessages', 'mqtt.onStatus', 'lifecycle.onBeforeClose']) {
    const unsubscribe = methodAt(adapter, method)(() => {});
    assert.equal(typeof unsubscribe, 'function');
    assert.equal(unsubscribe(), undefined);
    assert.equal(unsubscribe(), undefined);
  }
});

test('safe reads return neutral values without sharing mutable results', async () => {
  const adapter = createUnavailableRuntimeAdapter('test');
  const reads = [
    ['connection.list', []],
    ['connection.messageCounts', []],
    ['subscription.list', []],
    ['history.queryMessages', { rows: [], total: 0, page: 1, pageSize: 100 }],
    ['history.queryLogs', { rows: [], total: 0, page: 1, pageSize: 100 }],
    ['publishHistory.list', []],
    ['settings.getAll', {}],
    [
      'storage.stats',
      {
        messageCount: 0,
        logCount: 0,
        publishCount: 0,
        totalCount: 0,
        databaseBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        totalBytes: 0,
      },
    ],
    ['clipboard.readText', ''],
  ];

  for (const [method, expected] of reads) {
    const first = await methodAt(adapter, method)();
    const second = await methodAt(adapter, method)();
    assert.deepEqual(first, expected);
    if (first !== null && typeof first === 'object') {
      assert.notEqual(first, second, `${method} must return a fresh value`);
      if ('rows' in first) assert.notEqual(first.rows, second.rows);
    }
  }
});
