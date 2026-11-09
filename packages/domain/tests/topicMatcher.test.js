import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesTopic } from '../src/topicMatcher.js';

test('matchesTopic supports MQTT wildcard filters used by subscriptions', () => {
  assert.equal(matchesTopic('device/a/status', 'device/+/status'), true);
  assert.equal(matchesTopic('device/a/online/status', 'device/+/status'), false);
  assert.equal(matchesTopic('device/a/status', 'device/#'), true);
  assert.equal(matchesTopic('/device/a/status', '/#'), true);
  assert.equal(matchesTopic('device/a/status', '/#'), false);
  assert.equal(matchesTopic('device/a/status', 'sensor/#'), false);
});

test('matchesTopic does not treat a shorter single-level filter as covering a status child topic', () => {
  assert.equal(matchesTopic(
    '/ls/hsli/shhhcl/+/+/status',
    '/ls/hsli/shhhcl/+/+'
  ), false);
});
