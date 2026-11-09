import assert from 'node:assert/strict';
import test from 'node:test';

import { formatReceivedPayloadPreview } from '@ineed-mqtt-tool/codecs/payload-codec';
import { normalizeMessageBatch } from '@ineed-mqtt-tool/mqtt-contract';
import { createHistoryPayload } from '../src/workspace/historyPayload.js';

function normalizePayload(payload) {
  return normalizeMessageBatch({
    connId: 'c',
    topic: 't',
    payload,
    qos: 0,
    retained: false,
    timestamp: 1,
  })[0].payload;
}

test('normalized MQTT text bytes stay intact through display and history boundaries', () => {
  const payload = normalizePayload('ok');
  const original = new Uint8Array(payload);

  assert.deepEqual(formatReceivedPayloadPreview(payload, 'text'), {
    text: 'ok',
    totalBytes: 2,
    truncated: false,
  });
  assert.deepEqual(formatReceivedPayloadPreview(payload, 'hex'), {
    text: '6F 6B',
    totalBytes: 2,
    truncated: false,
  });
  assert.deepEqual(createHistoryPayload({ payload, format: 'text' }), {
    payload: 'ok',
    format: 'text',
  });
  assert.deepEqual(createHistoryPayload({ payload, format: 'hex' }), {
    payload: '6F6B',
    format: 'hex',
  });
  assert.deepEqual(payload, original);
});

test('normalized MQTT JSON bytes decode and format at both consumers', () => {
  const payload = normalizePayload('{"ok":true}');
  const formatted = '{\n  "ok": true\n}';

  assert.equal(formatReceivedPayloadPreview(payload, 'json').text, formatted);
  assert.equal(createHistoryPayload({ payload, format: 'json' }).payload, formatted);
});

test('normalized non-UTF8 bytes use replacement text while preserving raw HEX', () => {
  const input = new Uint8Array([0xff, 0x00, 0x6b]);
  const payload = normalizePayload(input);
  const original = new Uint8Array(payload);

  assert.equal(formatReceivedPayloadPreview(payload, 'text').text, '\uFFFD\0k');
  assert.equal(formatReceivedPayloadPreview(payload, 'hex').text, 'FF 00 6B');
  assert.equal(createHistoryPayload({ payload, format: 'text' }).payload, '\uFFFD\0k');
  assert.equal(createHistoryPayload({ payload, format: 'hex' }).payload, 'FF006B');
  assert.deepEqual(input, new Uint8Array([0xff, 0x00, 0x6b]));
  assert.deepEqual(payload, original);
});
