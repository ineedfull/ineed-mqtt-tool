import assert from 'node:assert/strict';
import test from 'node:test';

import { validateHttpsUpdateUrl } from '../src/workspace/updateUrl.js';

test('validateHttpsUpdateUrl returns a normalized absolute HTTPS URL', () => {
  assert.equal(
    validateHttpsUpdateUrl('https://downloads.example.com/releases/app.zip?arch=arm64'),
    'https://downloads.example.com/releases/app.zip?arch=arm64',
  );
});

test('validateHttpsUpdateUrl rejects unsafe or ambiguous update URLs', () => {
  for (const value of [
    'http://downloads.example.com/app.zip',
    'javascript:alert(1)',
    'file:///tmp/app.zip',
    '//downloads.example.com/app.zip',
    '/app.zip',
    'https://user:password@downloads.example.com/app.zip',
    'not a url',
    '',
    null,
  ]) {
    assert.equal(validateHttpsUpdateUrl(value), null, String(value));
  }
});
