import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureRendererReadiness,
  createRendererReadinessReporter,
  sanitizeRendererFailure,
} from '../renderer/readinessReporter.js';

function mountedRoot(mounted = true) {
  return {
    hasAttribute(name) {
      return mounted && name === 'data-v-app';
    },
  };
}

test('production renderer keeps direct invoke and installs no reporting side effects', async () => {
  for (const challenge of ['', 'main-challenge', '00000000-0000-4000-7000-000000000000']) {
    const events = [];
    const listeners = [];
    const invoke = async () => 'production-result';
    const readiness = configureRendererReadiness({
      challenge,
      emit: async (...args) => events.push(args),
      eventTarget: {
        addEventListener: (...args) => listeners.push(args),
      },
      invoke,
    });

    assert.equal(readiness.invoke, invoke);
    const originalErrorHandler = () => 'production-handler';
    const app = { config: { errorHandler: originalErrorHandler } };
    readiness.configureVueApp(app, { fault: 'vue-lifecycle' });
    assert.equal(app.config.errorHandler, originalErrorHandler);
    assert.equal(await readiness.invoke('db_get_connections', {}), 'production-result');
    readiness.markMounted(mountedRoot());
    readiness.reportBootstrapError(new Error('production mount error'));
    await Promise.resolve();

    assert.deepEqual(listeners, []);
    assert.deepEqual(events, []);
  }
});

test('wrapped invoke preserves receiver and synchronous outcomes', () => {
  const events = [];
  const receiver = { result: 'sync-result' };
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });
  const wrapped = reporter.wrapInvoke(function nativeInvoke(command) {
    assert.equal(this, receiver);
    assert.equal(command, 'db_get_connections');
    return this.result;
  });

  assert.equal(Reflect.apply(wrapped, receiver, ['db_get_connections']), 'sync-result');
  assert.deepEqual(events, []);

  const failure = new Error('sync failure');
  const throwing = reporter.wrapInvoke(function nativeThrow() {
    assert.equal(this, receiver);
    throw failure;
  });
  assert.throws(() => Reflect.apply(throwing, receiver, []), failure);
});

test('wrapped invoke marks only fulfilled promises and thenables as successful', async () => {
  const events = [];
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });
  reporter.markMounted(mountedRoot());
  const rejection = new Error('async failure');

  await assert.rejects(
    reporter.wrapInvoke(() => Promise.reject(rejection))(),
    rejection,
  );
  assert.deepEqual(events, []);

  const value = await reporter.wrapInvoke(() => ({
    then(resolve) { resolve('thenable-result'); },
  }))();
  await Promise.resolve();
  assert.equal(value, 'thenable-result');
  assert.equal(events[0][0], 'app:renderer-ready');
});

test('Vue error before invoke is terminal and chains an existing throwing handler', async () => {
  const challenge = 'de305d54-75b4-431b-adb2-eb6b9e546014';
  const events = [];
  const previousFailure = new Error('existing handler failed');
  const handlerCalls = [];
  const app = {
    config: {
      errorHandler(...args) {
        handlerCalls.push({ args, receiver: this });
        throw previousFailure;
      },
    },
    mixin() {},
  };
  const readiness = configureRendererReadiness({
    challenge,
    emit: async (...args) => events.push(args),
    eventTarget: { addEventListener() {} },
    invoke: () => 'sync-result',
  });
  readiness.configureVueApp(app);
  const vueFailure = new TypeError('private Vue failure');

  assert.throws(
    () => Reflect.apply(app.config.errorHandler, app.config, [vueFailure, {}, 'mounted hook']),
    previousFailure,
  );
  assert.throws(
    () => Reflect.apply(app.config.errorHandler, app.config, [vueFailure, {}, 'mounted hook']),
    previousFailure,
  );
  assert.equal(readiness.invoke('db_get_connections'), 'sync-result');
  readiness.markMounted(mountedRoot());
  await Promise.resolve();

  assert.equal(handlerCalls.length, 2);
  assert.equal(handlerCalls[0].receiver, app.config);
  assert.deepEqual(events, [[
    'app:renderer-error',
    { challenge, kind: 'vue', reason: 'TypeError' },
  ]]);
});

test('Vue error after successful invoke still blocks readiness before mount', async () => {
  const challenge = 'de305d54-75b4-431b-adb2-eb6b9e546014';
  const events = [];
  const app = { config: { errorHandler: undefined }, mixin() {} };
  const readiness = configureRendererReadiness({
    challenge,
    emit: async (...args) => events.push(args),
    eventTarget: { addEventListener() {} },
    invoke: () => 'sync-result',
  });
  readiness.configureVueApp(app);

  assert.equal(readiness.invoke('db_get_connections'), 'sync-result');
  app.config.errorHandler(new Error('lifecycle failed'), {}, 'mounted hook');
  readiness.markMounted(mountedRoot());
  await Promise.resolve();

  assert.deepEqual(events, [[
    'app:renderer-error',
    { challenge, kind: 'vue', reason: 'Error' },
  ]]);
});

test('valid smoke challenge enables complete renderer reporting', async () => {
  const challenge = 'de305d54-75b4-431b-adb2-eb6b9e546014';
  const events = [];
  const listeners = [];
  const invoke = async () => 'smoke-result';
  const readiness = configureRendererReadiness({
    challenge,
    emit: async (...args) => events.push(args),
    eventTarget: {
      addEventListener: (...args) => listeners.push(args),
    },
    invoke,
  });

  assert.notEqual(readiness.invoke, invoke);
  assert.deepEqual(listeners.map(([kind]) => kind), ['error', 'unhandledrejection']);
  readiness.markMounted(mountedRoot());
  assert.equal(await readiness.invoke('db_get_connections', {}), 'smoke-result');
  await Promise.resolve();

  assert.deepEqual(events, [[
    'app:renderer-ready',
    { challenge, invokeSucceeded: true, mounted: true },
  ]]);
});

test('mount without a successful native invoke cannot report renderer readiness', async () => {
  const events = [];
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });

  reporter.markMounted(mountedRoot());
  await Promise.resolve();

  assert.deepEqual(events, []);
});

test('successful native invoke without Vue mount evidence cannot report readiness', async () => {
  const events = [];
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });
  const invoke = reporter.wrapInvoke(async () => ({ rows: [] }));

  assert.deepEqual(await invoke('db_get_connections', {}), { rows: [] });
  await Promise.resolve();

  assert.deepEqual(events, []);
});

test('mount and invoke races emit readiness exactly once after both succeed', async () => {
  const events = [];
  let resolveInvoke;
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });
  const invoke = reporter.wrapInvoke(() => new Promise(resolve => { resolveInvoke = resolve; }));
  const pending = invoke('db_get_connections', {});

  reporter.markMounted(mountedRoot());
  reporter.markMounted(mountedRoot());
  assert.deepEqual(events, []);
  resolveInvoke(['connection']);
  assert.deepEqual(await pending, ['connection']);
  await Promise.resolve();
  await reporter.wrapInvoke(async () => 'again')('db_get_all_settings', {});

  assert.deepEqual(events, [[
    'app:renderer-ready',
    {
      challenge: 'main-challenge',
      invokeSucceeded: true,
      mounted: true,
    },
  ]]);
});

test('a rejected native invoke does not satisfy readiness', async () => {
  const events = [];
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });
  const invoke = reporter.wrapInvoke(async () => { throw new Error('database unavailable'); });
  reporter.markMounted(mountedRoot());

  await assert.rejects(() => invoke('db_get_connections', {}), /database unavailable/u);
  await Promise.resolve();
  assert.deepEqual(events, []);
});

test('renderer error is terminal, sanitized, bounded, and emitted exactly once', async () => {
  const events = [];
  const reporter = createRendererReadinessReporter({
    challenge: 'main-challenge',
    emit: async (...args) => events.push(args),
  });

  reporter.reportError('unhandledrejection', Object.assign(new Error('password=hunter2'), {
    name: `Private${'x'.repeat(500)}`,
  }));
  reporter.reportError('error', new TypeError('token=secret'));
  reporter.markMounted(mountedRoot());
  await reporter.wrapInvoke(async () => 'ok')('db_get_connections', {});
  await Promise.resolve();

  assert.deepEqual(events, [[
    'app:renderer-error',
    {
      challenge: 'main-challenge',
      kind: 'unhandledrejection',
      reason: 'Error',
    },
  ]]);
  assert.equal(JSON.stringify(events).includes('hunter2'), false);
  assert.equal(JSON.stringify(events).includes('secret'), false);
});

test('failure sanitizer exposes only an allowlisted error class', () => {
  assert.equal(sanitizeRendererFailure(new TypeError('password=hidden')), 'TypeError');
  assert.equal(sanitizeRendererFailure(new ReferenceError('token=hidden')), 'ReferenceError');
  assert.equal(sanitizeRendererFailure('mqtt://user:password@example.test'), 'NonErrorRejection');
  assert.equal(sanitizeRendererFailure({ name: 'SensitiveCustomError' }), 'Error');
  assert.ok(sanitizeRendererFailure(new Error('x')).length <= 32);
});
