import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistoryPayload,
  formatStoredHistoryPayload,
  normalizeHistoryFormat,
} from '../src/workspace/historyPayload.js';

test('history payload stores received HEX directly as compact uppercase payload', () => {
  assert.deepEqual(createHistoryPayload({
    payload: 'ignored',
    payloadHex: '7b226f6b223a747275657d',
    format: 'hex',
  }), {
    payload: '7B226F6B223A747275657D',
    format: 'hex',
  });
});

test('history payload stores the actual sent bytes when send mode is HEX', () => {
  assert.deepEqual(createHistoryPayload({
    payload: '{"ok":true}',
    bytes: new TextEncoder().encode('{"ok":true}'),
    format: 'hex',
  }), {
    payload: '7B226F6B223A747275657D',
    format: 'hex',
  });
});

test('history payload formats valid JSON and preserves invalid JSON and text', () => {
  assert.equal(createHistoryPayload({ payload: '{"ok":true}', format: 'json' }).payload, '{\n  "ok": true\n}');
  assert.equal(createHistoryPayload({ payload: '{"ok":', format: 'json' }).payload, '{"ok":');
  assert.equal(createHistoryPayload({ payload: 'plain', format: 'text' }).payload, 'plain');
});

test('old history format defaults to text and stored HEX is spaced for display', () => {
  assert.equal(normalizeHistoryFormat(''), 'text');
  assert.equal(formatStoredHistoryPayload({ payload: '7b226f6b', format: 'hex' }), '7B 22 6F 6B');
});

test('history payload decodes Uint8Array text and JSON without losing the original bytes', () => {
  const textBytes = new Uint8Array([0x6f, 0x6b]);
  const jsonBytes = new TextEncoder().encode('{"ok":true}');

  assert.deepEqual(createHistoryPayload({ payload: textBytes, format: 'text' }), {
    payload: 'ok',
    format: 'text',
  });
  assert.deepEqual(createHistoryPayload({ payload: jsonBytes, format: 'json' }), {
    payload: '{\n  "ok": true\n}',
    format: 'json',
  });
  assert.deepEqual(textBytes, new Uint8Array([0x6f, 0x6b]));
  assert.deepEqual(jsonBytes, new TextEncoder().encode('{"ok":true}'));
});

test('history payload stores raw Uint8Array bytes as compact uppercase HEX', () => {
  const payload = new Uint8Array([0xff, 0x00, 0x6b]);

  assert.deepEqual(createHistoryPayload({ payload, format: 'hex' }), {
    payload: 'FF006B',
    format: 'hex',
  });
  assert.deepEqual(createHistoryPayload({ payload, payloadHex: 'aa bb', format: 'hex' }), {
    payload: 'AABB',
    format: 'hex',
  });
  assert.equal(createHistoryPayload({ payload, format: 'text' }).payload, '\uFFFD\0k');
  assert.deepEqual(payload, new Uint8Array([0xff, 0x00, 0x6b]));
});
