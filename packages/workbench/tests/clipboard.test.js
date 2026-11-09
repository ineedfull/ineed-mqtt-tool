import assert from 'node:assert/strict';
import test from 'node:test';

import { copyText } from '../src/workspace/clipboard.js';

test('copyText writes the normalized value through the injected clipboard', async () => {
  const written = [];
  const clipboard = {
    async writeText(value) {
      written.push(value);
    },
  };

  assert.deepEqual(await copyText(42, clipboard), { ok: true });
  assert.deepEqual(await copyText(null, clipboard), { ok: true });
  assert.deepEqual(written, ['42', '']);
});

test('copyText reports missing, thrown, and rejected clipboard failures', async () => {
  assert.deepEqual(await copyText('value'), {
    ok: false,
    error: 'Clipboard unavailable',
  });
  assert.deepEqual(await copyText('value', {
    writeText() {
      throw new Error('sync failure');
    },
  }), { ok: false, error: 'sync failure' });
  assert.deepEqual(await copyText('value', {
    writeText() {
      return Promise.reject(new Error('async failure'));
    },
  }), { ok: false, error: 'async failure' });
});

test('copyText never falls back to browser or desktop globals', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let globalWrites = 0;
  const globalClipboard = { writeText() { globalWrites += 1; } };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: globalClipboard },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronClipboard: globalClipboard },
  });

  try {
    assert.deepEqual(await copyText('value', undefined), {
      ok: false,
      error: 'Clipboard unavailable',
    });
    assert.equal(globalWrites, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
});
