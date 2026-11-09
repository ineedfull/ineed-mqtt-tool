import assert from 'node:assert/strict';
import test from 'node:test';

import { withTimeout } from '../src/workspace/withTimeout.js';

test('withTimeout clears its timer when the source settles', async (t) => {
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCalls = 0;
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  });

  assert.equal(await withTimeout(Promise.resolve('ready'), 1000, 'too slow'), 'ready');
  assert.equal(clearCalls, 1);
});

test('withTimeout rejects with the exact timeout error and handles late rejection', async () => {
  const source = Promise.withResolvers();
  const timed = withTimeout(source.promise, 1, '工作区数据加载超时');

  await assert.rejects(timed, new Error('工作区数据加载超时'));
  source.reject(new Error('late source failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('withTimeout cancellation clears the timer and settles the wrapper', async () => {
  const source = Promise.withResolvers();
  const timed = withTimeout(source.promise, 1000, 'too slow');

  timed.cancel();

  await assert.rejects(timed, { name: 'AbortError', message: 'Operation cancelled' });
});
