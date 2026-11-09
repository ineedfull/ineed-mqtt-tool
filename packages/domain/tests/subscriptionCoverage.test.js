import test from 'node:test';
import assert from 'node:assert/strict';

import { findCoveringSubscription } from '../src/subscriptionCoverage.js';

test('findCoveringSubscription detects active wildcard subscription that already covers a topic', () => {
  const covering = findCoveringSubscription([
    { id: 'existing', connId: 'conn-a', topic: '/#', status: 'active' },
    { id: 'other-conn', connId: 'conn-b', topic: '/dev/test', status: 'active' },
    { id: 'inactive', connId: 'conn-a', topic: '/dev/#', status: 'inactive' }
  ], { id: 'next', connId: 'conn-a', topic: '/dev/test' });

  assert.equal(covering?.id, 'existing');
});

test('findCoveringSubscription ignores pending, inactive, and self subscriptions', () => {
  const covering = findCoveringSubscription([
    { id: 'self', connId: 'conn-a', topic: '/#', status: 'active' },
    { id: 'pending', connId: 'conn-a', topic: '/#', status: 'pending' },
    { id: 'inactive', connId: 'conn-a', topic: '/#', status: 'inactive' }
  ], { id: 'self', connId: 'conn-a', topic: '/dev/test' });

  assert.equal(covering, null);
});
