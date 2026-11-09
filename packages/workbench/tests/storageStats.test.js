import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStorageBytes, normalizeStorageStats } from '../src/workspace/storageStats.js';

test('formatStorageBytes selects a readable binary unit', () => {
  assert.equal(formatStorageBytes(0), '0 B');
  assert.equal(formatStorageBytes(1536), '1.5 KB');
  assert.equal(formatStorageBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatStorageBytes(2.25 * 1024 * 1024 * 1024), '2.25 GB');
});

test('normalizeStorageStats provides numeric zero defaults', () => {
  assert.deepEqual(normalizeStorageStats({ messageCount: '12', totalBytes: 4096 }), {
    messageCount: 12,
    logCount: 0,
    publishCount: 0,
    totalCount: 12,
    databaseBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    totalBytes: 4096
  });
});

test('normalizeStorageStats rejects non-finite and negative numeric values', () => {
  assert.deepEqual(normalizeStorageStats({
    messageCount: Infinity,
    logCount: NaN,
    publishCount: -1,
    databaseBytes: 'Infinity',
    walBytes: 'not-a-number',
    shmBytes: -5,
    totalBytes: Infinity,
    totalCount: Infinity,
  }), {
    messageCount: 0,
    logCount: 0,
    publishCount: 0,
    totalCount: 0,
    databaseBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    totalBytes: 0,
  });

  assert.equal(normalizeStorageStats({ messageCount: 2, totalCount: Infinity }).totalCount, 2);
  assert.equal(normalizeStorageStats({ messageCount: 2, totalCount: 0 }).totalCount, 0);
});

test('formatStorageBytes returns zero for non-finite and negative values', () => {
  assert.equal(formatStorageBytes(Infinity), '0 B');
  assert.equal(formatStorageBytes(NaN), '0 B');
  assert.equal(formatStorageBytes(-1), '0 B');
});
