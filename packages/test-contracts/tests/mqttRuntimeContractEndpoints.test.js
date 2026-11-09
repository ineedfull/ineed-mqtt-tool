import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import test from 'node:test';

import { Aedes } from 'aedes';

import { createElectronHarness } from '../../../tooling/mqtt-load-test/electronHarness.mjs';
import { createTauriHarness } from '../../../tooling/mqtt-load-test/tauriHarness.mjs';

const require = createRequire(import.meta.url);
const mqttRequire = createRequire(require.resolve('mqtt'));
const { WebSocketServer } = mqttRequire('ws');
const mqttPacket = mqttRequire('mqtt-packet');

async function startBroker(host, websocket) {
  const broker = websocket ? null : await Aedes.createBroker();
  const paths = [];
  const identities = [];
  const sockets = new Set();
  const server = websocket ? createHttpServer() : createTcpServer(broker.handle);
  const ws = websocket ? new WebSocketServer({ server }) : null;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  broker?.on('client', client => identities.push(client.id));
  ws?.on('connection', (socket, request) => {
    paths.push(request.url);
    const parser = mqttPacket.parser();
    const subscriptions = new Set();
    const send = packet => socket.send(mqttPacket.generate(packet));
    // MQTT packets can span multiple WebSocket messages; retain one parser per socket.
    parser.on('error', () => socket.terminate());
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') {
        identities.push(packet.clientId);
        send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      } else if (packet.cmd === 'subscribe') {
        for (const subscription of packet.subscriptions) subscriptions.add(subscription.topic);
        send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 1) });
      } else if (packet.cmd === 'publish') {
        if (packet.qos === 1) send({ cmd: 'puback', messageId: packet.messageId });
        if (subscriptions.has(packet.topic)) {
          send({ cmd: 'publish', topic: packet.topic, payload: packet.payload, qos: 0, retain: false, dup: false });
        }
      } else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
      else if (packet.cmd === 'disconnect') socket.close();
    });
    socket.on('message', data => parser.parse(data));
  });
  server.listen(0, host);
  await once(server, 'listening');
  return {
    port: server.address().port, paths, identities,
    async close() {
      for (const socket of ws?.clients || []) socket.terminate();
      for (const socket of sockets) socket.destroy();
      if (broker) await new Promise(resolve => broker.close(resolve));
      if (ws) await new Promise(resolve => ws.close(resolve));
      await new Promise(resolve => server.close(resolve));
      assert.equal(sockets.size, 0);
    },
  };
}

async function roundTrip(harness, id, sequence) {
  const topic = `endpoint/${id}`;
  const payload = `${id}:${sequence}:连接回环`;
  assert.equal((await harness.command('subscribe', id, topic, 1)).ok, true);
  assert.equal((await harness.command('publish', id, topic, payload, 1, false)).ok, true);
  const message = await harness.waitMessage(event => (
    event.connId === id && event.payloadHex === Buffer.from(payload).toString('hex')
  ));
  assert.equal(message.topic, topic);
}

for (const runtime of ['electron', 'tauri']) {
  for (const websocket of [false, true]) {
    test(`${runtime} real ${websocket ? 'WebSocket paths' : 'TCP'} support IPv6 and reject invalid edits without dropping the session`, {
      timeout: 150_000,
    }, async t => {
      const brokers = [];
      let harness;
      t.after(async () => {
        try { await harness?.close(); }
        finally { for (const broker of brokers) await broker.close(); }
      });
      harness = runtime === 'electron' ? createElectronHarness() : await createTauriHarness();
      let sequence = 0;
      for (const bindHost of ['127.0.0.1', '::1']) {
        const broker = await startBroker(bindHost, websocket);
        brokers.push(broker);
        const hosts = bindHost === '::1' ? ['::1', '[::1]'] : [bindHost];
        const paths = websocket ? ['', '/', 'tenant/mqtt?x=1&clientId=query-id'] : [''];
        for (const host of hosts) {
          for (const path of paths) {
            const id = `endpoint-${runtime}-${sequence++}`;
            const config = {
              id, host, port: broker.port, protocol: websocket ? 'ws' : 'mqtt',
              path, clientId: `configured-${id}`, autoReconnect: false,
            };
            const connected = await harness.command('connect', config);
            assert.equal(connected.ok, true, `${host} ${path}: ${JSON.stringify(connected)}`);
            await roundTrip(harness, id, 0);
            const invalidEdits = [{ host: '::1]' }, { host: 'user@broker' }];
            if (websocket) invalidEdits.push({ path: '/mqtt#fragment' }, { path: '/mqtt\n' });
            for (const [index, edit] of invalidEdits.entries()) {
              assert.equal((await harness.command('connect', { ...config, ...edit })).ok, false);
              await roundTrip(harness, id, index + 1);
            }
            assert.equal((await harness.command('disconnect', id)).ok, true);
            assert.equal(broker.identities.at(-1), config.clientId);
            if (websocket) {
              assert.equal(broker.paths.at(-1), path ? (path.startsWith('/') ? path : `/${path}`) : '/mqtt');
            }
          }
        }
        assert.equal(broker.identities.length, hosts.length * paths.length);
      }
    });
  }
}
