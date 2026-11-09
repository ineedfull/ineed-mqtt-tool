import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUpdate } from '../src/workspace/prepareUpdate.js';

test('update preparation drains work, disconnects, then flushes every persistence writer', async () => {
  const order = [];
  await prepareUpdate({ drain: async () => order.push('drain'), disconnect: async () => order.push('disconnect'),
    writers: [{ flushStrict: async () => order.push('messages') }, { flushStrict: async () => order.push('settings') }] });
  assert.deepEqual(order, ['drain', 'disconnect', 'messages', 'settings']);
});

test('failed disconnect or writer never reports successful update preparation', async () => {
  for (const phase of ['disconnect', 'flush']) {
    await assert.rejects(prepareUpdate({ drain: async () => {},
      disconnect: async () => { if (phase === 'disconnect') throw new Error('disconnect failed'); },
      writers: [{ flushStrict: async () => { throw new Error('flush failed'); } }] }), /failed/);
  }
});

test('timed-out preparation cannot disconnect a resumed session when its old drain finishes', async () => {
  const drained = Promise.withResolvers();
  let disconnects = 0;
  let writes = 0;
  await assert.rejects(prepareUpdate({ timeoutMs: 5, drain: () => drained.promise,
    disconnect: async () => { disconnects++; }, writers: [{ flushStrict: async () => { writes++; } }] }), /超时/);
  drained.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnects, 0);
  assert.equal(writes, 0);
});
