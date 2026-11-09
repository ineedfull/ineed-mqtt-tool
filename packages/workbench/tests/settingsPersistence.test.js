import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsPersistence } from '../src/workspace/settingsPersistence.js';

test('settings persistence runs snapshots serially and flush waits for queued writes', async () => {
  const firstWrite = Promise.withResolvers();
  const calls = [];
  const persistence = createSettingsPersistence({
    persist(key, value) {
      calls.push([key, value]);
      return key === 'first' ? firstWrite.promise : Promise.resolve();
    },
  });

  persistence.enqueue({ first: 1 });
  persistence.enqueue({ second: 2 });
  const flush = persistence.flush();
  let flushed = false;
  void flush.then(() => { flushed = true; });
  await Promise.resolve();

  assert.deepEqual(calls, [['first', 1]]);
  assert.equal(flushed, false);

  firstWrite.resolve();
  await flush;
  assert.deepEqual(calls, [['first', 1], ['second', 2]]);
  assert.equal(flushed, true);
});

test('settings persistence contains individual failures and continues later writes', async () => {
  const calls = [];
  const errors = [];
  const persistence = createSettingsPersistence({
    async persist(key, value) {
      calls.push([key, value]);
      if (key === 'broken') throw new Error('disk unavailable');
    },
    onError(error, key, value) {
      errors.push([error.message, key, value]);
    },
  });

  persistence.enqueue({ broken: 1, healthy: 2 });
  persistence.enqueue({ later: 3 });
  await persistence.flush();

  assert.deepEqual(calls, [['broken', 1], ['healthy', 2], ['later', 3]]);
  assert.deepEqual(errors, [['disk unavailable', 'broken', 1]]);
});

test('settings persistence snapshots values when they are enqueued', async () => {
  const saved = [];
  const value = { theme: 'light' };
  const persistence = createSettingsPersistence({
    async persist(key, settingValue) {
      saved.push([key, settingValue]);
    },
  });

  persistence.enqueue(value);
  value.theme = 'dark';
  await persistence.flush();

  assert.deepEqual(saved, [['theme', 'light']]);
});

test('settings persistence validates required callbacks', () => {
  assert.throws(
    () => createSettingsPersistence({}),
    new TypeError('persist must be a function'),
  );
  assert.throws(
    () => createSettingsPersistence({ persist() {}, onError: true }),
    new TypeError('onError must be a function'),
  );
});
test('strict settings flush retries retained failed values and rejects continuing failures', async () => {
  let fail = true;
  const written = [];
  const persistence = createSettingsPersistence({ persist: async (key, value) => {
    if (fail) throw new Error('disk full');
    written.push([key, value]);
  } });
  await persistence.enqueue({ theme: 'dark' });
  await assert.rejects(persistence.flushStrict(), /disk full/);
  fail = false;
  await persistence.flushStrict();
  assert.deepEqual(written, [['theme', 'dark']]);
});
