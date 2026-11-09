import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSubscriptionWarning,
  assignSubscriptionColor,
  getSubscriptionColor,
  incrementMatchedSubscriptionCounts,
  matchMessageSubscriptions,
  resetSubscriptionMessageCounts,
  subscriptionColorPalette,
  selectPrimarySubscription
} from '../src/subscriptionRouting.js';
import * as subscriptionRouting from '../src/subscriptionRouting.js';

const subscriptions = [
  { id: 'wide', connId: 'conn-a', topic: '/#', status: 'active' },
  { id: 'dev', connId: 'conn-a', topic: '/dev/#', status: 'active' },
  { id: 'exact', connId: 'conn-a', topic: '/dev/test', status: 'active' },
  { id: 'other', connId: 'conn-b', topic: '/dev/test', status: 'active' }
];

test('matchMessageSubscriptions returns all matching subscriptions on the same connection', () => {
  const matches = matchMessageSubscriptions(subscriptions, 'conn-a', '/dev/test');

  assert.deepEqual(matches.map(sub => sub.id), ['exact', 'dev', 'wide']);
});

test('message classification keeps working while subscriptions transition to active', () => {
  const transitioning = [
    { id: 'pending', connId: 'conn-a', topic: '/dev/+', status: 'pending' },
    { id: 'inactive', connId: 'conn-a', topic: '/dev/#', status: 'inactive' }
  ];

  const matches = matchMessageSubscriptions(transitioning, 'conn-a', '/dev/test');

  assert.deepEqual(matches.map(subscription => subscription.id), ['pending', 'inactive']);
});

test('selectPrimarySubscription prefers the most specific matching subscription', () => {
  const primary = selectPrimarySubscription(subscriptions, 'conn-a', '/dev/test');

  assert.equal(primary?.id, 'exact');
});

test('buildSubscriptionWarning reports duplicate and overlap without blocking subscribe', () => {
  assert.equal(
    buildSubscriptionWarning(subscriptions, { connId: 'conn-a', topic: '/dev/test' }).type,
    'duplicate'
  );
  assert.equal(
    buildSubscriptionWarning(subscriptions, { connId: 'conn-a', topic: '/dev/device-1' }).type,
    'covered'
  );
  assert.equal(
    buildSubscriptionWarning([{ id: 'exact', connId: 'conn-a', topic: '/dev/test', status: 'active' }], { connId: 'conn-a', topic: '/#' }).type,
    'covers'
  );
});

test('assignSubscriptionColor picks an unused color on the same connection', () => {
  const color = assignSubscriptionColor([
    { connId: 'conn-a', color: subscriptionColorPalette[0] },
    { connId: 'conn-a', color: subscriptionColorPalette[1] },
    { connId: 'conn-b', color: subscriptionColorPalette[2] }
  ], 'conn-a');

  assert.equal(color, subscriptionColorPalette[2]);
});

test('subscription palette keeps colors visually distinct', () => {
  const rgb = color => [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
  const distances = subscriptionColorPalette.flatMap((color, index) =>
    subscriptionColorPalette.slice(index + 1).map(other => {
      const left = rgb(color);
      const right = rgb(other);
      return Math.hypot(...left.map((value, channel) => value - right[channel]));
    })
  );

  assert.ok(Math.min(...distances) >= 60);
});

test('assignSubscriptionColor does not reuse a color after the palette is exhausted', () => {
  const used = subscriptionColorPalette.map((color, index) => ({
    id: 'sub-' + index,
    connId: 'conn-a',
    color
  }));

  const next = assignSubscriptionColor(used, 'conn-a');

  assert.equal(used.some(subscription => subscription.color.toLowerCase() === next.toLowerCase()), false);
});

test('stored legacy and duplicate colors are reassigned during loading', () => {
  assert.equal(typeof subscriptionRouting.shouldReassignSubscriptionColor, 'function');
  assert.equal(
    subscriptionRouting.shouldReassignSubscriptionColor([], { connId: 'conn-a', color: '#2563eb' }),
    true
  );
  assert.equal(
    subscriptionRouting.shouldReassignSubscriptionColor(
      [{ id: 'existing', connId: 'conn-a', color: subscriptionColorPalette[0] }],
      { id: 'next', connId: 'conn-a', color: subscriptionColorPalette[0] }
    ),
    true
  );
});

test('getSubscriptionColor returns stored color before falling back', () => {
  assert.equal(getSubscriptionColor({ id: 'sub-a', color: '#123456' }), '#123456');
  assert.match(getSubscriptionColor({ id: 'sub-a' }), /^#[0-9a-f]{6}$/);
});

test('subscription counters accumulate matched receive messages without double counting one subscription', () => {
  const wide = { id: 'wide', messageCount: 4 };
  const exact = { id: 'exact', messageCount: 1 };

  incrementMatchedSubscriptionCounts([wide, exact, wide]);

  assert.equal(wide.messageCount, 5);
  assert.equal(exact.messageCount, 2);
});

test('subscription counters reset only for the cleared connection', () => {
  const subscriptionsWithCounts = [
    { id: 'a', connId: 'conn-a', messageCount: 8 },
    { id: 'b', connId: 'conn-b', messageCount: 5 }
  ];

  resetSubscriptionMessageCounts(subscriptionsWithCounts, 'conn-a');

  assert.equal(subscriptionsWithCounts[0].messageCount, 0);
  assert.equal(subscriptionsWithCounts[1].messageCount, 5);
});
