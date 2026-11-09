import test from 'node:test';
import assert from 'node:assert/strict';

import { getPayloadValidity, formatPayloadOnBlur } from '../src/workspace/payloadEditorState.js';

test('payload editor accepts text mode without JSON parsing', () => {
  assert.equal(getPayloadValidity('plain text {', 'text'), true);
});

test('payload editor validates JSON mode', () => {
  assert.equal(getPayloadValidity('{"ok":true}', 'json'), true);
  assert.equal(getPayloadValidity('{"ok":', 'json'), false);
});

test('payload editor formats valid JSON on blur and leaves invalid JSON unchanged', () => {
  assert.equal(formatPayloadOnBlur('{"ok":true}', 'json'), '{\n  "ok": true\n}');
  assert.equal(formatPayloadOnBlur('{"ok":', 'json'), '{"ok":');
  assert.equal(formatPayloadOnBlur('plain text', 'text'), 'plain text');
});
