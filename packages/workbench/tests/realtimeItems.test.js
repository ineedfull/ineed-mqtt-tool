import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRealtimeItem,
  appendRealtimeItemsByConnection,
  createRealtimeItemId,
  normalizeLimit,
  trimRealtimeItemsByConnection,
} from '../src/workspace/realtimeItems.js';

test('appendRealtimeItem keeps the newest items within the normalized limit', () => {
  const items = Array.from({ length: 101 }, (_, index) => ({ id: index }));

  const next = appendRealtimeItem(items, { id: 101 }, 100);

  assert.equal(next.length, 100);
  assert.equal(next[0].id, 2);
  assert.equal(next.at(-1).id, 101);
});

test('normalizeLimit clamps invalid and extreme values', () => {
  assert.equal(normalizeLimit('bad', 1000), 1000);
  assert.equal(normalizeLimit(20, 1000), 100);
  assert.equal(normalizeLimit(100000, 1000), 50000);
});

test('createRealtimeItemId stays unique inside the same millisecond', () => {
  const originalNow = Date.now;
  Date.now = () => 123456;
  try {
    assert.notEqual(createRealtimeItemId('msg'), createRealtimeItemId('msg'));
  } finally {
    Date.now = originalNow;
  }
});

test('realtime limits are applied independently to each connection', () => {
  const items = [
    { id: 'b1', connId: 'b' },
    ...Array.from({ length: 100 }, (_, index) => ({ id: `a${index}`, connId: 'a' })),
  ];

  const next = appendRealtimeItemsByConnection(items, [
    { id: 'a100', connId: 'a' },
    { id: 'a101', connId: 'a' },
    { id: 'b2', connId: 'b' },
  ], 100);

  assert.deepEqual(next.filter(item => item.connId === 'b').map(item => item.id), ['b1', 'b2']);
  assert.equal(next.filter(item => item.connId === 'a').length, 100);
  assert.equal(next.find(item => item.connId === 'a').id, 'a2');
  assert.equal(next.filter(item => item.connId === 'a').at(-1).id, 'a101');
});

test('changing the realtime limit trims every connection without clearing quieter connections', () => {
  const items = [
    { id: 'b1', connId: 'b' },
    { id: 'b2', connId: 'b' },
    ...Array.from({ length: 101 }, (_, index) => ({ id: `a${index}`, connId: 'a' })),
  ];

  const trimmed = trimRealtimeItemsByConnection(items, 100);

  assert.deepEqual(trimmed.filter(item => item.connId === 'b').map(item => item.id), ['b1', 'b2']);
  assert.equal(trimmed.filter(item => item.connId === 'a').length, 100);
  assert.equal(trimmed.find(item => item.connId === 'a').id, 'a1');
});
