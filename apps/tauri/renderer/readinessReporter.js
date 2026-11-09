const ALLOWED_ERROR_NAMES = new Set([
  'Error',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
]);
const ALLOWED_ERROR_KINDS = new Set(['bootstrap', 'error', 'unhandledrejection', 'vue']);
const SMOKE_CHALLENGE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NOOP = () => {};

function emitContained(emit, event, payload) {
  try {
    Promise.resolve(Reflect.apply(emit, undefined, [event, payload])).catch(() => {});
  } catch {
    // The native watchdog reports a failed readiness/error event channel.
  }
}

export function sanitizeRendererFailure(reason) {
  const name = reason instanceof Error ? reason.name : undefined;
  return ALLOWED_ERROR_NAMES.has(name) ? name.slice(0, 32) : (
    reason !== null && typeof reason === 'object' ? 'Error' : 'NonErrorRejection'
  );
}

export function createRendererReadinessReporter({ challenge = '', emit } = {}) {
  if (typeof emit !== 'function') throw new TypeError('renderer reporter emit is required');
  const safeChallenge = typeof challenge === 'string' ? challenge.slice(0, 128) : '';
  let failed = false;
  let invokeSucceeded = false;
  let mounted = false;
  let readyEmitted = false;
  let errorEmitted = false;

  function reportReady() {
    if (failed || readyEmitted || !mounted || !invokeSucceeded) return;
    readyEmitted = true;
    emitContained(emit, 'app:renderer-ready', {
      challenge: safeChallenge,
      invokeSucceeded: true,
      mounted: true,
    });
  }

  function markMounted(root) {
    if (!root || typeof root.hasAttribute !== 'function' || !root.hasAttribute('data-v-app')) {
      throw new TypeError('Vue mount evidence is missing');
    }
    mounted = true;
    reportReady();
  }

  function wrapInvoke(nativeInvoke) {
    if (typeof nativeInvoke !== 'function') throw new TypeError('native invoke is required');
    function recordSuccess(result) {
      invokeSucceeded = true;
      reportReady();
      return result;
    }
    return function invokeWithReadiness(...args) {
      const result = Reflect.apply(nativeInvoke, this, args);
      const canBeThenable = result !== null
        && (typeof result === 'object' || typeof result === 'function');
      if (canBeThenable && typeof result.then === 'function') {
        return Promise.resolve(result).then(recordSuccess);
      }
      return recordSuccess(result);
    };
  }

  function reportError(kind, reason) {
    failed = true;
    if (errorEmitted) return;
    errorEmitted = true;
    emitContained(emit, 'app:renderer-error', {
      challenge: safeChallenge,
      kind: ALLOWED_ERROR_KINDS.has(kind) ? kind : 'error',
      reason: sanitizeRendererFailure(reason),
    });
  }

  return Object.freeze({ markMounted, reportError, wrapInvoke });
}

export function configureRendererReadiness({ challenge = '', emit, eventTarget, invoke } = {}) {
  if (typeof challenge !== 'string' || !SMOKE_CHALLENGE.test(challenge)) {
    return Object.freeze({
      configureVueApp: NOOP,
      invoke,
      markMounted: NOOP,
      reportBootstrapError: NOOP,
    });
  }
  const reporter = createRendererReadinessReporter({ challenge, emit });
  eventTarget.addEventListener('error', event => reporter.reportError('error', event.error));
  eventTarget.addEventListener(
    'unhandledrejection',
    event => reporter.reportError('unhandledrejection', event.reason),
  );
  function configureVueApp(app, { fault } = {}) {
    if (!app?.config || typeof app.mixin !== 'function') {
      throw new TypeError('Vue application is required');
    }
    const previousErrorHandler = app.config.errorHandler;
    app.config.errorHandler = function smokeVueErrorHandler(...args) {
      reporter.reportError('vue', args[0]);
      if (typeof previousErrorHandler === 'function') {
        return Reflect.apply(previousErrorHandler, this, args);
      }
      return undefined;
    };
    if (fault === 'vue-lifecycle') {
      app.mixin({
        mounted() { throw new Error('Tauri smoke Vue lifecycle fault'); },
      });
    }
  }
  return Object.freeze({
    configureVueApp,
    invoke: reporter.wrapInvoke(invoke),
    markMounted: reporter.markMounted,
    reportBootstrapError: error => reporter.reportError('bootstrap', error),
  });
}
