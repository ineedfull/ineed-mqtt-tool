export const REQUIRED_RUNTIME_METHODS = Object.freeze([
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
]);

// Older preview/test adapters may expose only check; native adapters expose this extension.
export const OPTIONAL_UPDATE_METHODS = Object.freeze([
  'update.getState', 'update.onState', 'update.download', 'update.cancel', 'update.install',
]);

export class RuntimeUnavailableError extends Error {
  constructor(method, runtimeName) {
    super(`Runtime method "${method}" is unavailable in ${runtimeName}`);
    this.name = 'RuntimeUnavailableError';
    this.code = 'RUNTIME_METHOD_UNAVAILABLE';
    this.method = method;
    this.runtimeName = runtimeName;
  }
}

function ownDataValueAtDottedPath(value, dottedPath) {
  for (const key of dottedPath.split('.')) {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      return undefined;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return undefined;
    }

    value = descriptor.value;
  }
  return value;
}

function setDottedPath(target, dottedPath, value) {
  const keys = dottedPath.split('.');
  const finalKey = keys.pop();
  let parent = target;

  for (const key of keys) {
    let descriptor = Object.getOwnPropertyDescriptor(parent, key);
    if (!descriptor) {
      Object.defineProperty(parent, key, {
        configurable: true,
        enumerable: true,
        value: Object.create(null),
        writable: true,
      });
      descriptor = Object.getOwnPropertyDescriptor(parent, key);
    }
    parent = descriptor.value;
  }

  Object.defineProperty(parent, finalKey, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function assertRuntimeAdapter(adapter) {
  const invalid = REQUIRED_RUNTIME_METHODS.filter(
    (method) => typeof ownDataValueAtDottedPath(adapter, method) !== 'function',
  );

  if (invalid.length > 0) {
    throw new TypeError(
      `Runtime adapter is missing required methods: ${invalid.join(', ')}`,
    );
  }

  const runtimeNameDescriptor = Object.getOwnPropertyDescriptor(
    adapter,
    'runtimeName',
  );
  const runtimeName = runtimeNameDescriptor
    && Object.hasOwn(runtimeNameDescriptor, 'value')
    ? runtimeNameDescriptor.value
    : undefined;

  if (typeof runtimeName !== 'string' || runtimeName.trim() === '') {
    throw new TypeError(
      'Runtime adapter must have a nonblank own data runtimeName',
    );
  }

  return adapter;
}

const SAFE_READ_FACTORIES = {
  'connection.list': () => [],
  'connection.messageCounts': () => [],
  'subscription.list': () => [],
  'history.queryMessages': () => ({ rows: [], total: 0, page: 1, pageSize: 100 }),
  'history.queryLogs': () => ({ rows: [], total: 0, page: 1, pageSize: 100 }),
  'publishHistory.list': () => [],
  'settings.getAll': () => ({}),
  'storage.stats': () => ({
    messageCount: 0,
    logCount: 0,
    publishCount: 0,
    totalCount: 0,
    databaseBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    totalBytes: 0,
  }),
  'clipboard.readText': () => '',
  'update.getState': () => ({ phase: 'idle', supported: false, error: '' }),
};

const EVENT_METHODS = new Set([
  'mqtt.onMessages',
  'mqtt.onStatus',
  'lifecycle.onBeforeClose',
  'update.onState',
]);

export function createUnavailableRuntimeAdapter(runtimeName) {
  if (typeof runtimeName !== 'string' || runtimeName.trim() === '') {
    throw new TypeError('runtimeName must be a nonblank string');
  }

  const adapter = { runtimeName };

  for (const method of [...REQUIRED_RUNTIME_METHODS, ...OPTIONAL_UPDATE_METHODS]) {
    const safeReadFactory = SAFE_READ_FACTORIES[method];
    let implementation;

    if (safeReadFactory) {
      implementation = async () => safeReadFactory();
    } else if (EVENT_METHODS.has(method)) {
      implementation = () => () => {};
    } else {
      implementation = async () => {
        throw new RuntimeUnavailableError(method, runtimeName);
      };
    }

    setDottedPath(adapter, method, implementation);
  }

  return adapter;
}
