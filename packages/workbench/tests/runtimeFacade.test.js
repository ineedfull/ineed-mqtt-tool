import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_RUNTIME_METHODS,
  OPTIONAL_UPDATE_METHODS,
  createUnavailableRuntimeAdapter,
} from '@ineed-mqtt-tool/runtime-contract';
import { createRuntimeFacade } from '../src/workspace/runtimeFacade.js';

const LEGACY_DB_PATHS = {
  getConnections: 'connection.list',
  saveConnection: 'connection.save',
  deleteConnection: 'connection.delete',
  getMessageCounts: 'connection.messageCounts',
  getSubscriptions: 'subscription.list',
  addSubscription: 'subscription.add',
  removeSubscription: 'subscription.remove',
  saveMessages: 'history.saveMessages',
  saveLogs: 'history.saveLogs',
  queryHistoryMessages: 'history.queryMessages',
  deleteHistoryMessage: 'history.deleteMessage',
  clearHistoryMessages: 'history.clearMessages',
  queryHistoryLogs: 'history.queryLogs',
  deleteHistoryLog: 'history.deleteLog',
  clearHistoryLogs: 'history.clearLogs',
  getPublishHistory: 'publishHistory.list',
  savePublish: 'publishHistory.save',
  getAllSettings: 'settings.getAll',
  saveSetting: 'settings.save',
  getStorageStats: 'storage.stats',
  clearHistoryStorage: 'storage.clearHistory',
};

const CAPABILITY_PATHS = {
  mqtt: {
    connect: 'mqtt.connect',
    disconnect: 'mqtt.disconnect',
    subscribe: 'mqtt.subscribe',
    unsubscribe: 'mqtt.unsubscribe',
    publish: 'mqtt.publish',
    onMessages: 'mqtt.onMessages',
    onStatus: 'mqtt.onStatus',
  },
  clipboard: {
    readText: 'clipboard.readText',
    writeText: 'clipboard.writeText',
  },
  window: {
    openHistory: 'window.openHistory',
    openExternal: 'window.openExternal',
  },
  lifecycle: {
    onBeforeClose: 'lifecycle.onBeforeClose',
  },
  update: {
    check: 'update.check',
    getState: 'update.getState',
    onState: 'update.onState',
    download: 'update.download',
    cancel: 'update.cancel',
    install: 'update.install',
  },
};

const DB_NAMESPACES = new Set([
  'connection',
  'subscription',
  'history',
  'publishHistory',
  'settings',
  'storage',
]);

function adapterSnapshot(adapter) {
  return Reflect.ownKeys(adapter).map((key) => {
    const value = adapter[key];
    const members = value && typeof value === 'object'
      ? Reflect.ownKeys(value).map((member) => [member, value[member]])
      : undefined;
    return [key, value, members];
  });
}

function createFakeAdapter() {
  const adapter = createUnavailableRuntimeAdapter('fake-runtime');
  const calls = [];
  const outcomes = new Map();
  const rejectionReason = new Error('sentinel rejection');
  const rejection = Promise.reject(rejectionReason);
  void rejection.catch(() => {});

  for (const path of [...REQUIRED_RUNTIME_METHODS, ...OPTIONAL_UPDATE_METHODS]) {
    const [namespace, method] = path.split('.');
    const outcome = path === 'history.deleteLog'
      ? rejection
      : Promise.resolve({ path });
    outcomes.set(path, outcome);
    adapter[namespace][method] = function (...args) {
      calls.push({ args, path, receiver: this });
      return outcome;
    };
  }

  return { adapter, calls, outcomes, rejectionReason };
}

function poisonAdapter(adapter) {
  let accessorReads = 0;

  for (const namespaceName of Object.keys(CAPABILITY_PATHS).concat(
    [...DB_NAMESPACES].filter((name) => !Object.hasOwn(CAPABILITY_PATHS, name)),
  )) {
    const namespace = adapter[namespaceName];
    for (const method of Reflect.ownKeys(namespace)) {
      namespace[method] = () => {
        throw new Error(`replaced ${namespaceName}.${String(method)}`);
      };
    }
    Object.defineProperty(adapter, namespaceName, {
      configurable: true,
      get() {
        accessorReads += 1;
        throw new Error(`read replaced ${namespaceName}`);
      },
    });
  }

  Object.defineProperty(adapter, 'runtimeName', {
    configurable: true,
    get() {
      accessorReads += 1;
      throw new Error('read replaced runtimeName');
    },
  });

  return () => accessorReads;
}

test('legacy db mappings explicitly cover every required DB-side path exactly once', () => {
  const requiredDbPaths = REQUIRED_RUNTIME_METHODS.filter((path) => (
    DB_NAMESPACES.has(path.split('.')[0])
  ));
  const mappedPaths = Object.values(LEGACY_DB_PATHS);

  assert.equal(new Set(mappedPaths).size, mappedPaths.length);
  assert.deepEqual(mappedPaths.toSorted(), requiredDbPaths.toSorted());
  assert.deepEqual(LEGACY_DB_PATHS, {
    getConnections: 'connection.list',
    saveConnection: 'connection.save',
    deleteConnection: 'connection.delete',
    getMessageCounts: 'connection.messageCounts',
    getSubscriptions: 'subscription.list',
    addSubscription: 'subscription.add',
    removeSubscription: 'subscription.remove',
    saveMessages: 'history.saveMessages',
    saveLogs: 'history.saveLogs',
    queryHistoryMessages: 'history.queryMessages',
    deleteHistoryMessage: 'history.deleteMessage',
    clearHistoryMessages: 'history.clearMessages',
    queryHistoryLogs: 'history.queryLogs',
    deleteHistoryLog: 'history.deleteLog',
    clearHistoryLogs: 'history.clearLogs',
    getPublishHistory: 'publishHistory.list',
    savePublish: 'publishHistory.save',
    getAllSettings: 'settings.getAll',
    saveSetting: 'settings.save',
    getStorageStats: 'storage.stats',
    clearHistoryStorage: 'storage.clearHistory',
  });
});

test('createRuntimeFacade captures every capability with its receiver and call behavior', async () => {
  const { adapter, calls, outcomes, rejectionReason } = createFakeAdapter();
  const before = adapterSnapshot(adapter);

  const facade = createRuntimeFacade(adapter);

  assert.deepEqual(adapterSnapshot(adapter), before);
  assert.deepEqual(Reflect.ownKeys(facade), [
    'runtimeName',
    'db',
    'mqtt',
    'clipboard',
    'window',
    'lifecycle',
    'update',
  ]);
  assert.deepEqual(Reflect.ownKeys(facade.db), Reflect.ownKeys(LEGACY_DB_PATHS));
  for (const [capability, paths] of Object.entries(CAPABILITY_PATHS)) {
    assert.deepEqual(Reflect.ownKeys(facade[capability]), Reflect.ownKeys(paths));
  }
  assert.equal(facade.runtimeName, 'fake-runtime');

  const originalNamespaces = Object.fromEntries(
    REQUIRED_RUNTIME_METHODS.map((path) => path.split('.')[0])
      .filter((namespace, index, namespaces) => namespaces.indexOf(namespace) === index)
      .map((namespace) => [namespace, adapter[namespace]]),
  );
  const getAccessorReads = poisonAdapter(adapter);

  const mappings = [
    ...Object.entries(LEGACY_DB_PATHS).map(([method, path]) => ['db', method, path]),
    ...Object.entries(CAPABILITY_PATHS).flatMap(([capability, paths]) => (
      Object.entries(paths).map(([method, path]) => [capability, method, path])
    )),
  ];

  for (const [capability, method, path] of mappings) {
    const sentinelArguments = [Symbol(path), { path }];
    const result = facade[capability][method](...sentinelArguments);

    assert.equal(result, outcomes.get(path), `${path} return value`);
    assert.deepEqual(calls.at(-1), {
      args: sentinelArguments,
      path,
      receiver: originalNamespaces[path.split('.')[0]],
    });
  }

  await assert.rejects(facade.db.deleteHistoryLog(), (error) => {
    assert.equal(error, rejectionReason);
    return true;
  });
  assert.equal(getAccessorReads(), 0);
});

test('createRuntimeFacade freezes the exact public capability boundary', () => {
  const { adapter } = createFakeAdapter();
  const facade = createRuntimeFacade(adapter);

  for (const value of [
    facade,
    facade.db,
    facade.mqtt,
    facade.clipboard,
    facade.window,
    facade.lifecycle,
    facade.update,
  ]) {
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Reflect.set(value, 'extra', () => {}), false);
  }
  assert.equal(Reflect.set(facade, 'runtimeName', 'changed'), false);
  assert.equal(Reflect.set(facade.db, 'getConnections', () => {}), false);
  assert.equal(facade.runtimeName, 'fake-runtime');
  assert.equal(typeof facade.db.getConnections, 'function');
});

test('createRuntimeFacade rejects incomplete adapters through the runtime contract', () => {
  const adapter = createUnavailableRuntimeAdapter('incomplete');
  delete adapter.storage.stats;

  assert.throws(
    () => createRuntimeFacade(adapter),
    new TypeError('Runtime adapter is missing required methods: storage.stats'),
  );
});
