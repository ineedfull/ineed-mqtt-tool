import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';

import { createElectronHarness } from '../../../tooling/mqtt-load-test/electronHarness.mjs';
import { createTauriHarness } from '../../../tooling/mqtt-load-test/tauriHarness.mjs';
import { startLocalBroker } from '../../../tooling/mqtt-load-test/localBroker.mjs';

function oversizedPublish() {
  const topic = Buffer.from('hostile/oversized');
  const payload = Buffer.alloc(8_388_609, 0x61);
  let length = 2 + topic.length + payload.length;
  const remaining = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 128;
    remaining.push(digit);
  } while (length > 0);
  const topicLength = Buffer.alloc(2);
  topicLength.writeUInt16BE(topic.length);
  return Buffer.concat([Buffer.from([0x30, ...remaining]), topicLength, topic, payload]);
}

async function hostileBroker(packet, truncate) {
  const sockets = new Set();
  const timers = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (truncate) socket.end(packet);
        else socket.write(packet);
      }, 100);
      timers.add(timer);
    });
    socket.resume();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    host: '127.0.0.1', port: server.address().port,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      assert.equal(sockets.size, 0);
    },
  };
}

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} contains malformed and oversized broker packets and can reconnect after each attack`, { timeout: 150_000 }, async t => {
    const goodBroker = await startLocalBroker();
    let harness;
    t.after(async () => {
      try { await harness?.close(); }
      finally { await goodBroker.close(); }
    });
    harness = runtime === 'electron' ? createElectronHarness() : await createTauriHarness();
    for (const [name, packet, truncate] of [
      ['reserved-packet-type', Buffer.from([0x00, 0x00]), false],
      ['invalid-remaining-length', Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]), false],
      ['truncated-publish', Buffer.from([0x30, 0x10, 0x00, 0x01, 0x61]), true],
      ['over-8MiB-payload', oversizedPublish(), false],
    ]) {
      const hostile = await hostileBroker(packet, truncate);
      const id = `hostile-${runtime}-${name}`;
      t.diagnostic(`${name}: starting attack`);
      try {
        assert.equal((await harness.command('connect', { id, host: hostile.host, port: hostile.port, protocol: 'mqtt', autoReconnect: false })).ok, true);
        let diagnostic;
        try {
          diagnostic = await harness.waitStatus(event => event.connId === id &&
            ['error', 'offline'].includes(event.status) && event.code, 5_000);
        } catch (error) {
          t.diagnostic(JSON.stringify(harness.events));
          throw error;
        }
        assert.ok(diagnostic.code);
        assert.equal(harness.events.filter(event => event.type === 'message' && event.connId === id).length, 0);
        assert.equal((await harness.command('disconnect', id)).ok, true);
        assert.equal((await harness.command('connect', {
          id, host: goodBroker.host, port: goodBroker.port, protocol: 'mqtt',
          username: goodBroker.username, password: goodBroker.password, autoReconnect: false,
        })).ok, true);
        assert.equal((await harness.command('subscribe', id, 'hostile-recovery/#', 1)).ok, true);
        assert.equal((await harness.command('publish', id, 'hostile-recovery/sentinel', name, 1, false)).ok, true);
        await harness.waitMessage(message => message.connId === id && message.payloadHex === Buffer.from(name).toString('hex'));
        assert.equal((await harness.command('disconnect', id)).ok, true);
        t.diagnostic(`${name}: rejected; valid session and payload recovered`);
      } finally { await hostile.close(); }
    }
  });
}
