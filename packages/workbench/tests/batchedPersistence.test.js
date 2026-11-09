import test from 'node:test';
import assert from 'node:assert/strict';

import { createBatchedPersistence } from '../src/workspace/batchedPersistence.js';

test('batched persistence requires a persistence function', () => {
  assert.throws(() => createBatchedPersistence(), {
    name: 'TypeError',
    message: 'persistBatch must be a function',
  });
  assert.throws(() => createBatchedPersistence({ persistBatch: null }), {
    name: 'TypeError',
    message: 'persistBatch must be a function',
  });
});

const invalidNumericOptions = [
  {
    name: 'maxBatchSize',
    values: [0, -1, 1.5, Infinity, NaN, '1'],
  },
  {
    name: 'maxQueueSize',
    values: [0, -1, 1.5, Infinity, NaN, '1'],
  },
  {
    name: 'maxRetries',
    values: [-1, 1.5, Infinity, NaN, '1'],
  },
  {
    name: 'flushMs',
    values: [-1, Infinity, NaN, '1'],
  },
];

for (const { name, values } of invalidNumericOptions) {
  test(`batched persistence rejects invalid ${name}`, () => {
    for (const value of values) {
      assert.throws(
        () => createBatchedPersistence({ [name]: value, persistBatch: async () => {} }),
        error => error instanceof TypeError && error.message.includes(name),
        `${name}=${String(value)}`,
      );
    }
  });
}

test('batched persistence flushes many records through one scheduled callback', async () => {
  const saved = [];
  let scheduled = null;
  const batcher = createBatchedPersistence({
    maxBatchSize: 100,
    schedule: (fn) => { scheduled = fn; return 1; },
    persistBatch: (rows) => saved.push(rows.map(row => row.id))
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  batcher.enqueue({ id: 3 });

  assert.equal(saved.length, 0);
  assert.equal(typeof scheduled, 'function');
  await scheduled();

  assert.deepEqual(saved, [[1, 2, 3]]);
});

test('batched persistence flushes immediately at max batch size', async () => {
  const saved = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 200,
    schedule: () => 1,
    clear: () => {},
    persistBatch: (rows) => saved.push(rows.map(row => row.id))
  });

  for (let i = 1; i <= 200; i += 1) {
    batcher.enqueue({ id: i });
  }
  await batcher.flush();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 200);
  assert.equal(saved[0][0], 1);
  assert.equal(saved[0][199], 200);
});

test('batched persistence keeps asynchronous writes serial', async () => {
  const saved = [];
  let releaseFirst;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    persistBatch: async (rows) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      saved.push(rows.map(row => row.id));
      if (rows[0].id === 1) await firstWrite;
      activeWrites -= 1;
    }
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  await Promise.resolve();

  assert.deepEqual(saved, [[1]]);
  releaseFirst();
  await batcher.flush();

  assert.deepEqual(saved, [[1], [2]]);
  assert.equal(maxActiveWrites, 1);
});

test('sustained arrivals share one pending flush while a database write is stalled', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const saved = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 10, maxQueueSize: 2000, schedule: () => 1, clear: () => {},
    persistBatch: async rows => { await blocked; saved.push(...rows.map(row => row.id)); },
  });
  batcher.enqueue({ id: 0 });
  const pending = batcher.flush();
  const joins = new Set();
  for (let id = 1; id <= 1000; id++) {
    batcher.enqueue({ id });
    joins.add(batcher.flush());
  }
  // The bounded row queue must not hide an unbounded Promise waiter queue.
  assert.equal(joins.size, 1);
  assert.equal(joins.has(pending), true);
  release();
  await pending;
  assert.deepEqual(saved, Array.from({ length: 1001 }, (_, id) => id));
  assert.equal(batcher.size(), 0);
});

test('flush joined during drain settlement waits for rows enqueued in that window', async () => {
  const saved = [];
  let batcher;
  let secondFlush = null;
  let persistenceCalls = 0;
  const firstPersistence = {
    then(resolve) {
      resolve();
      queueMicrotask(() => {
        queueMicrotask(() => {
          batcher.enqueue({ id: 2 });
          secondFlush = batcher.flush();
        });
      });
    },
  };
  batcher = createBatchedPersistence({
    schedule: () => 1,
    clear: () => {},
    persistBatch: rows => {
      persistenceCalls += 1;
      saved.push(rows.map(row => row.id));
      return persistenceCalls === 1 ? firstPersistence : undefined;
    },
  });

  batcher.enqueue({ id: 1 });
  const firstFlush = batcher.flush();
  await firstFlush;

  assert.notEqual(secondFlush, null);
  await secondFlush;
  assert.deepEqual(saved, [[1], [2]]);
  assert.equal(batcher.size(), 0);
});

test('batched persistence retries an asynchronously rejected batch', async () => {
  let attempts = 0;
  const saved = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 2,
    retryDelay: () => Promise.resolve(),
    persistBatch: async (rows) => {
      attempts += 1;
      if (attempts === 1) throw new Error('database is locked');
      saved.push(rows.map(row => row.id));
    }
  });

  batcher.enqueue({ id: 1 });
  await batcher.flush();

  assert.equal(attempts, 2);
  assert.deepEqual(saved, [[1]]);
  assert.equal(batcher.size(), 0);
});

test('retry delay rejection reports the batch dropped without rejecting flush', async () => {
  const retryFailure = new Error('retry scheduling failed');
  const drops = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 1,
    retryDelay: async () => { throw retryFailure; },
    warn: () => {},
    onDrop: (rows, metadata) => drops.push({ ids: rows.map(row => row.id), metadata }),
    persistBatch: async () => { throw new Error('persistence failed'); },
  });

  batcher.enqueue({ id: 1 });
  await assert.doesNotReject(() => batcher.flush());

  assert.deepEqual(drops, [{
    ids: [1],
    metadata: { reason: 'persist-failed', error: retryFailure },
  }]);
});

test('batched persistence bounds pending rows and reports dropped records', async () => {
  const saved = [];
  const dropped = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 10,
    maxQueueSize: 2,
    schedule: () => 1,
    clear: () => {},
    onDrop: rows => dropped.push(...rows.map(row => row.id)),
    persistBatch: async rows => saved.push(rows.map(row => row.id))
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  batcher.enqueue({ id: 3 });
  await batcher.flush();

  assert.deepEqual(dropped, [1]);
  assert.deepEqual(saved, [[2, 3]]);
});

test('queue overflow reports an explicit drop reason', async () => {
  const drops = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 10,
    maxQueueSize: 1,
    schedule: () => 1,
    clear: () => {},
    onDrop: (rows, metadata) => drops.push({ ids: rows.map(row => row.id), metadata }),
    persistBatch: async () => {},
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  await batcher.flush();

  assert.deepEqual(drops, [{ ids: [1], metadata: { reason: 'queue-overflow' } }]);
});

test('batched persistence reports a batch after finite retries are exhausted', async () => {
  let attempts = 0;
  const failures = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 1,
    retryDelay: () => Promise.resolve(),
    warn: () => {},
    onError: (error, rows) => failures.push({ message: error.message, ids: rows.map(row => row.id) }),
    persistBatch: async () => {
      attempts += 1;
      throw new Error('disk I/O error');
    }
  });

  batcher.enqueue({ id: 7 });
  await batcher.flush();

  assert.equal(attempts, 2);
  assert.deepEqual(failures, [{ message: 'disk I/O error', ids: [7] }]);
  assert.equal(batcher.size(), 0);
});

test('terminal persistence failure reports a drop and continues draining later batches', async () => {
  const failure = new Error('first batch failed');
  const attempts = [];
  const saved = [];
  const failures = [];
  const drops = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 0,
    warn: () => {},
    onError: (error, rows) => failures.push({ error, ids: rows.map(row => row.id) }),
    onDrop: (rows, metadata) => drops.push({ ids: rows.map(row => row.id), metadata }),
    persistBatch: async rows => {
      attempts.push(rows.map(row => row.id));
      if (rows[0].id === 1) throw failure;
      saved.push(rows.map(row => row.id));
    },
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  await batcher.flush();

  assert.deepEqual(attempts, [[1], [2]]);
  assert.deepEqual(saved, [[2]]);
  assert.deepEqual(failures, [{ error: failure, ids: [1] }]);
  assert.deepEqual(drops, [{
    ids: [1],
    metadata: { reason: 'persist-failed', error: failure },
  }]);
  assert.equal(batcher.size(), 0);
});

test('terminal callback exceptions are guarded while remaining batches continue', async () => {
  const saved = [];
  const warnings = [];
  const batcher = createBatchedPersistence({
    maxBatchSize: 1,
    maxRetries: 0,
    warn: (...args) => warnings.push(args.join(' ')),
    onError: () => { throw new Error('error callback failed'); },
    onDrop: () => { throw new Error('drop callback failed'); },
    persistBatch: async rows => {
      if (rows[0].id === 1) throw new Error('persistence failed');
      saved.push(rows.map(row => row.id));
    },
  });

  batcher.enqueue({ id: 1 });
  batcher.enqueue({ id: 2 });
  await assert.doesNotReject(() => batcher.flush());

  assert.deepEqual(saved, [[2]]);
  assert.equal(warnings.some(message => message.includes('flush failed')), true);
  assert.equal(warnings.some(message => message.includes('error callback failed')), true);
  assert.equal(warnings.some(message => message.includes('drop callback failed')), true);
});

test('automatic flush handles failures without rejecting its scheduled callback', async () => {
  let scheduled = null;
  const batcher = createBatchedPersistence({
    maxRetries: 0,
    schedule: fn => { scheduled = fn; return 1; },
    warn: () => { throw new Error('warning callback failed'); },
    onError: () => { throw new Error('error callback failed'); },
    onDrop: () => { throw new Error('drop callback failed'); },
    persistBatch: async () => { throw new Error('automatic persistence failed'); },
  });

  batcher.enqueue({ id: 1 });

  assert.equal(typeof scheduled, 'function');
  await assert.doesNotReject(() => scheduled());
  assert.equal(batcher.size(), 0);
});
test('strict flush refuses to approve updates after unrecoverable persistence loss', async () => {
  const persistence = createBatchedPersistence({ persistBatch: async () => { throw new Error('disk full'); },
    maxRetries: 0, warn: () => {}, schedule: () => 1, clear: () => {} });
  persistence.enqueue({ id: 1 });
  await assert.rejects(persistence.flushStrict(), /disk full/);
  await assert.rejects(persistence.flushStrict(), /disk full/);
});

test('strict flush refuses update installation after a queue overflow', async () => {
  const persistence = createBatchedPersistence({ persistBatch: async () => {}, maxQueueSize: 1,
    schedule: () => 1, clear: () => {} });
  persistence.enqueue({ id: 1 });
  persistence.enqueue({ id: 2 });
  await assert.rejects(persistence.flushStrict(), /丢失/);
});
