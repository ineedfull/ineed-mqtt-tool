import assert from 'node:assert/strict';
import test from 'node:test';
import { originalMessageContent } from '../src/workspace/messageInspector.js';
test('original JSON copy preserves wire whitespace rather than the formatted display', () => {
  assert.equal(originalMessageContent({ payload: '{ "v":1 }', displayPayload: '{\n  "v": 1\n}' }).text, '{ "v":1 }');
});
test('binary original copy is explicitly identified as HEX', () => {
  assert.deepEqual(originalMessageContent({ payload: '�\0', payloadHex: 'ff00' }), { text: 'FF 00', label: '复制 HEX 字节' });
});

test('original copy preserves the UTF-8 BOM and all whitespace bytes', () => {
  const payload = '\uFEFF { "温度": 23 }\r\n';
  const bytes = new TextEncoder().encode(payload);
  const result = originalMessageContent({ payload, payloadHex: Buffer.from(bytes).toString('hex') });
  assert.equal(result.text, payload);
  assert.deepEqual(new TextEncoder().encode(result.text), bytes);
});
