import { once } from 'node:events';
import { createServer } from 'node:net';

import { Aedes } from 'aedes';

const CLOSE_TIMEOUT_MS = 3_000;

function bounded(promise, label, timeoutMs = CLOSE_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function callbackPromise(operation) {
  return new Promise((resolve, reject) => {
    operation((error) => (error ? reject(error) : resolve()));
  });
}

export async function startLocalBroker({
  username = 'compat-user',
  password = 'compat-pass',
  port = 0,
} = {}) {
  const sockets = new Set();
  const clients = new Map();
  const broker = await Aedes.createBroker({
    authenticate(_client, suppliedUsername, suppliedPassword, callback) {
      const accepted = suppliedUsername?.toString() === username
        && suppliedPassword?.toString() === password;
      callback(null, accepted);
    },
  });
  const server = createServer(broker.handle);
  let closing = false;
  let closed = false;
  server.on('connection', (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  broker.on('clientReady', client => clients.set(client.id, client));
  broker.on('clientDisconnect', client => clients.delete(client.id));
  server.listen({ host: '127.0.0.1', port });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('broker did not select a TCP port');

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    const serverClose = server.listening
      ? callbackPromise(done => server.close(done))
      : Promise.resolve();
    closePromise = bounded((async () => {
      const errors = [];
      const drainConnections = async () => {
        for (let pass = 0; pass < 8; pass += 1) {
          for (const client of [...clients.values()]) {
            try { client.close(); } catch (error) { errors.push(error); }
          }
          for (const socket of [...sockets]) socket.destroy();
          await new Promise(resolve => setImmediate(resolve));
          if (sockets.size === 0) return;
        }
      };
      await drainConnections();
      try {
        await callbackPromise(done => broker.close(done));
      } catch (error) {
        errors.push(error);
      }
      await drainConnections();
      try {
        await serverClose;
      } catch (error) {
        errors.push(error);
      }
      clients.clear();
      if (errors.length > 0) throw new AggregateError(errors, 'local broker cleanup failed');
      closed = true;
    })(), 'local broker cleanup');
    return closePromise;
  }

  return Object.freeze({
    host: '127.0.0.1',
    port: address.port,
    username,
    password,
    dropClient(clientId) {
      const client = clients.get(clientId);
      if (!client) throw new Error(`broker client not found: ${clientId}`);
      client.close();
    },
    async waitForClient(clientId, timeoutMs = 3_000, signal) {
      if (clients.has(clientId)) return;
      if (signal?.aborted) throw signal.reason;
      let listener;
      let abort;
      try {
        await bounded(new Promise((resolve, reject) => {
          listener = (client) => {
            if (client.id !== clientId) return;
            broker.off('clientReady', listener);
            resolve();
          };
          abort = () => reject(signal.reason);
          broker.on('clientReady', listener);
          signal?.addEventListener('abort', abort, { once: true });
        }), `broker client ${clientId}`, timeoutMs);
      } finally {
        if (listener) broker.off('clientReady', listener);
        if (abort) signal?.removeEventListener('abort', abort);
      }
    },
    close,
    get openSocketCount() { return sockets.size; },
    get isClosed() { return closed; },
  });
}
