import assert from 'node:assert/strict';
import test from 'node:test';

import { createElectronHarness } from '../../../tooling/mqtt-load-test/electronHarness.mjs';
import { createTauriHarness } from '../../../tooling/mqtt-load-test/tauriHarness.mjs';
import { startLocalBroker } from '../../../tooling/mqtt-load-test/localBroker.mjs';

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} rejects invalid publish topics and keeps the live broker session usable`, { timeout: 150_000 }, async t => {
    const broker = await startLocalBroker();
    let harness;
    t.after(async () => {
      try { await harness?.close(); }
      finally { await broker.close(); }
    });
    harness = runtime === 'electron' ? createElectronHarness() : await createTauriHarness();
    const id = `publish-safety-${runtime}`;
    assert.equal((await harness.command('connect', {
      id, host: broker.host, port: broker.port, protocol: 'mqtt',
      username: broker.username, password: broker.password, autoReconnect: false,
    })).ok, true);
    assert.equal((await harness.command('subscribe', id, 'safe/#', 1)).ok, true);
    let sequence = 0;
    for (const topic of ['bad/#', 'bad/+', 'bad\u0000topic', 'bad\u0001topic', 'a'.repeat(65_536), '中'.repeat(21_846)]) {
      const result = await harness.command('publish', id, topic, 'invalid', 0, false);
      assert.equal(result.ok, false, `invalid topic ${topic.slice(0, 20)} must be rejected`);
      const sentinel = `recovered-${sequence++}`;
      assert.equal((await harness.command('publish', id, 'safe/sentinel', sentinel, 1, false)).ok, true);
      await harness.waitMessage(message => message.payloadHex === Buffer.from(sentinel).toString('hex'));
    }
    assert.equal(harness.events.filter(event => event.type === 'status' && event.status === 'error').length, 0);
    assert.equal((await harness.command('disconnect', id)).ok, true);
  });
}
