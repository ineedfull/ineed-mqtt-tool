import test from 'node:test';
import assert from 'node:assert/strict';

import { filterMessages } from '../src/workspace/messageFilters.js';

const messages = [
  { id: 'in-a', connId: 'conn-a', topic: '/dev/a', direction: 'in' },
  { id: 'out-a', connId: 'conn-a', topic: '/dev/a/set', direction: 'out' },
  { id: 'in-b', connId: 'conn-b', topic: '/dev/a', direction: 'in' }
];

test('filterMessages applies all, received, and sent directions for the active connection', () => {
  assert.deepEqual(
    filterMessages(messages, { connId: 'conn-a', direction: 'all' }).map(message => message.id),
    ['in-a', 'out-a']
  );
  assert.deepEqual(
    filterMessages(messages, { connId: 'conn-a', direction: 'in' }).map(message => message.id),
    ['in-a']
  );
  assert.deepEqual(
    filterMessages(messages, { connId: 'conn-a', direction: 'out' }).map(message => message.id),
    ['out-a']
  );
});

test('filterMessages keeps subscription and topic filters independent from direction', () => {
  assert.deepEqual(
    filterMessages(messages, {
      connId: 'conn-a',
      selectedSubscription: { topic: '/dev/#' },
      topic: '/set',
      direction: 'all'
    }).map(message => message.id),
    ['out-a']
  );
});

test('subscription selection limits RX but retains TX to a different topic on the same connection', () => {
  const options = { connId: 'conn-a', selectedSubscription: { topic: '/dev/a' } };
  const data = [...messages,
    { id: 'unrelated-rx', connId: 'conn-a', topic: '/other', direction: 'in' },
    { id: 'other-connection-tx', connId: 'conn-b', topic: '/dev/a/set', direction: 'out' }
  ];
  assert.deepEqual(filterMessages(data, options).map(m => m.id), ['in-a', 'out-a']);
  assert.deepEqual(filterMessages(data, { ...options, direction: 'in' }).map(m => m.id), ['in-a']);
  assert.deepEqual(filterMessages(data, { ...options, direction: 'out' }).map(m => m.id), ['out-a']);
  assert.deepEqual(filterMessages(data, { ...options, topic: '/set' }).map(m => m.id), ['out-a']);
  assert.deepEqual(filterMessages(data, { ...options, topic: 'missing' }), []);
});

test('wildcard subscription matching remains effective for received messages', () => {
  const data = [...messages, { id: 'other-rx', connId: 'conn-a', topic: '/dev/b', direction: 'in' }];
  assert.deepEqual(filterMessages(data, {
    connId: 'conn-a', selectedSubscription: { topic: '/dev/+' }
  }).map(m => m.id), ['in-a', 'out-a', 'other-rx']);
});
