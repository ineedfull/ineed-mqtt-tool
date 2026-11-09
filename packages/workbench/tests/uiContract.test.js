import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shellSource = await readFile(
  new URL('../src/layouts/MqttToolShell.vue', import.meta.url),
  'utf8',
);

function sourceBetween(start, end) {
  const startIndex = shellSource.indexOf(start);
  const endIndex = shellSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return shellSource.slice(startIndex, endIndex);
}

test('message classification does not mutate subscription lifecycle status', () => {
  const handler = sourceBetween(
    'function processIncomingMessages(batch)',
    '</script>',
  );

  assert.match(handler, /matchMessageSubscriptions\(subscriptions\.value, data\.connId, data\.topic\)/);
  assert.match(handler, /incrementMatchedSubscriptionCounts\(matchedSubscriptions\)/);
  assert.doesNotMatch(handler, /(?:sub|subscription)\.status\s*=/);
});

test('stored legacy and duplicate colors are reassigned during loading', () => {
  const loader = sourceBetween('async function loadData()', 'const activeTab = ref');

  assert.match(loader, /shouldReassignSubscriptionColor\(loadedSubscriptions, sub\)/);
  assert.match(loader, /sub\.color\s*=\s*assignSubscriptionColor\(loadedSubscriptions, sub\.connId\)/);
  assert.match(loader, /db\.addSubscription\(\{[^}]*color:\s*sub\.color/s);
  assert.match(loader, /loadedSubscriptions\.push\(sub\)/);
});

test('status bar uses connection session counters instead of retained realtime row counts', () => {
  assert.match(shellSource, /const msgCountIn = computed\(\(\) => activeConn\.value\.messagesIn \|\| 0\)/);
  assert.match(shellSource, /const msgCountOut = computed\(\(\) => activeConn\.value\.messagesOut \|\| 0\)/);
  assert.match(shellSource, /<span>收 <strong>\{\{ msgCountIn \}\}<\/strong><\/span>/);
  assert.match(shellSource, /<span>发 <strong>\{\{ msgCountOut \}\}<\/strong><\/span>/);
});
