import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryPayload } from '../../../packages/workbench/src/workspace/historyPayload.js';
import { matchMessageSubscriptions } from '../../../packages/domain/src/subscriptionRouting.js';
const require = createRequire(import.meta.url);
const { saveReceivedHistory } = require('../electron/receivedHistory.cjs');
const { createDatabase } = require('../electron/database.cjs');

test('native history formats and overlapping subscription priority agree with the workbench', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mqtt-native-format-'));
  const db = createDatabase(join(dir, 'mqtt.db'));
  try {
    db.saveConnection({ id: 'c', name: 'Native', host: 'localhost', port: 1883 });
    db.addSubscription({ id: 'broad', connection_id: 'c', topic: 'sensors/#', format: 'json' });
    db.addSubscription({ id: 'narrow', connection_id: 'c', topic: 'sensors/+/raw', format: 'hex' });
    const subscriptions = db.getSubscriptions('c').map(row => ({ ...row, connId: row.connection_id }));
    const cases = [ ['sensors/a/raw', Buffer.from([0, 255])], ['sensors/a/json', Buffer.from('{"z":1,"a":2}')], ['sensors/a/bad', Buffer.from('invalid json')], ['other/text', Buffer.from('原始文本')] ];
    for (const [topic, bytes] of cases) {
      const sub = matchMessageSubscriptions(subscriptions, 'c', topic)[0];
      const expected = createHistoryPayload({ payload: new Uint8Array(bytes), format: sub?.format || 'auto' });
      const message = { connId: 'c', topic, payload: Array.from(bytes), payloadText: bytes.toString('utf8'), qos: 2, retained: true };
      saveReceivedHistory(db, [message]);
      saveReceivedHistory(db, [message]);
      const { rows, total } = db.queryHistoryMessages({ topic });
      assert.equal(total, 1);
      assert.equal(rows[0].payload, expected.payload);
      assert.equal(rows[0].format, expected.format);
      assert.equal(rows[0].qos, 2);
      assert.equal(rows[0].retained, 1);
    }
  } finally { db.closeDatabase(); rmSync(dir, { recursive: true, force: true }); }
});
