import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultSettings, mergeSettings } from '../src/workspace/settingsModel.js';

test('mergeSettings coerces persisted string values using default setting types', () => {
  const merged = mergeSettings({
    largeFont: 'true',
    maxRealtimeMessages: '2500',
    timestampFormat: 'absolute'
  });

  assert.equal(merged.largeFont, true);
  assert.equal(merged.maxRealtimeMessages, 2500);
  assert.equal(merged.timestampFormat, 'absolute');
  assert.equal(merged.keepalive, defaultSettings.keepalive);
});

test('default realtime settings avoid amplifying high volume subscriptions', () => {
  assert.equal(defaultSettings.maxRealtimeMessages, 300);
  assert.equal(defaultSettings.maxLogEntries, 300);
  assert.equal(defaultSettings.persistReceiveLogs, false);
  assert.equal(defaultSettings.autoFormatReceivedJson, true);
  assert.equal(defaultSettings.maxAutoFormatPayloadBytes, 65536);
});

test('default settings cannot be mutated before future merges', () => {
  const originalKeepalive = defaultSettings.keepalive;
  const mutationSucceeded = Reflect.set(defaultSettings, 'keepalive', 1);
  if (mutationSucceeded) Reflect.set(defaultSettings, 'keepalive', originalKeepalive);

  assert.equal(Object.isFrozen(defaultSettings), true);
  assert.equal(mutationSucceeded, false);
  assert.equal(mergeSettings({}).keepalive, originalKeepalive);
});
