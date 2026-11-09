import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createMessageBatcher } = require('../electron/messageBatcher.cjs');

test('message batcher emits many MQTT messages through one scheduled flush', () => {
  let scheduled;
  const batches = [];
  const batcher = createMessageBatcher({
    flushMs: 50,
    maxBatchSize: 100,
    emitBatch: rows => batches.push(rows),
    schedule: (callback, delay) => {
      assert.equal(delay, 50);
      scheduled = callback;
      return 1;
    },
    clear: () => {},
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  batcher.enqueue({ id: 3 });
  assert.equal(batches.length, 0);

  scheduled();

  assert.deepEqual(batches, [[{ id: 1 }, { id: 2 }, { id: 3 }]]);
});

test('message batcher flushes immediately at the configured batch size', () => {
  const batches = [];
  const cleared = [];
  const batcher = createMessageBatcher({
    maxBatchSize: 2,
    emitBatch: rows => batches.push(rows),
    schedule: () => 17,
    clear: timer => cleared.push(timer),
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });

  assert.deepEqual(batches, [[{ id: 1 }, { id: 2 }]]);
  assert.deepEqual(cleared, [17]);
});

test('message batcher dispose drops pending rows and cancels its timer', () => {
  const batches = [];
  const cleared = [];
  const batcher = createMessageBatcher({
    emitBatch: rows => batches.push(rows),
    schedule: () => 23,
    clear: timer => cleared.push(timer),
  });

  batcher.enqueue({ id: 1 });
  batcher.dispose();
  batcher.enqueue({ id: 2 });

  assert.deepEqual(cleared, [23]);
  assert.deepEqual(batches, []);
  assert.equal(batcher.size, 0);
});

test('message batcher retains a failed batch and retries without throwing from its timer', () => {
  const scheduled = [];
  const emitted = [];
  const errors = [];
  let attempts = 0;
  const batcher = createMessageBatcher({
    emitBatch(rows) {
      attempts += 1;
      if (attempts === 1) throw new Error('renderer unavailable');
      emitted.push(rows);
    },
    onError: (error, rows, details) => errors.push([error.message, rows, details]),
    schedule: callback => { scheduled.push(callback); return scheduled.length; },
    clear: () => {},
  });
  batcher.enqueue({ id: 1 });

  assert.doesNotThrow(() => scheduled.shift()());
  assert.equal(batcher.size, 1);
  assert.equal(scheduled.length, 1);
  assert.doesNotThrow(() => scheduled.shift()());
  assert.deepEqual(emitted, [[{ id: 1 }]]);
  assert.deepEqual(errors, [[
    'renderer unavailable',
    [{ id: 1 }],
    { attempt: 1, maxRetries: 1 },
  ]]);
  assert.equal(batcher.size, 0);
});

test('message batcher drops once after its bounded retries are exhausted', () => {
  const scheduled = [];
  const errors = [];
  const drops = [];
  const batcher = createMessageBatcher({
    maxEmitRetries: 1,
    emitBatch() { throw new Error('permanent failure'); },
    onError: (_error, _rows, details) => errors.push(details),
    onDrop: (rows, error) => drops.push([rows, error.message]),
    schedule: callback => { scheduled.push(callback); return scheduled.length; },
    clear: () => {},
  });
  batcher.enqueue({ id: 1 });

  assert.doesNotThrow(() => scheduled.shift()());
  assert.doesNotThrow(() => scheduled.shift()());
  assert.deepEqual(errors, [
    { attempt: 1, maxRetries: 1 },
    { attempt: 2, maxRetries: 1 },
  ]);
  assert.deepEqual(drops, [[[{ id: 1 }], 'permanent failure']]);
  assert.equal(batcher.size, 0);
  assert.equal(scheduled.length, 0);
});
