'use strict';

// Owns MQTT client generations, ACKs, message batches, and history flush ordering.
const { buildBrokerUrl } = require('@ineed-mqtt-tool/mqtt-contract/endpoint');
const { createMessageBatcher } = require('./messageBatcher.cjs');
const { saveReceivedHistory } = require('./receivedHistory.cjs');
const { classifyMqttError, createMqttStatus } = require('./mqttDiagnostics.cjs');
const { IPC_CHANNELS } = require('./ipcContract.cjs');
const { errorMessage, nonblankString, normalizeQos } = require('./runtimeValidation.cjs');

const MQTT_CONNECT_TIMEOUT_MS = 12_000;

const MQTT_OPERATION_TIMEOUT_MS = 8_000;

const MQTT_END_TIMEOUT_MS = 3_000;

const MQTT_INBOUND_MAX_BYTES = 8_388_608;

function createMqttCoordinator({
  mqtt,
  db,
  send,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  scheduleBatch = (callback, delay) => setTimeout(callback, delay),
  clearBatch = timer => clearTimeout(timer),
} = {}) {
  if (typeof mqtt?.connect !== 'function') throw new TypeError('mqtt.connect is required');
  if (typeof send !== 'function') throw new TypeError('send is required');
  const clients = new Map();
  let nextGeneration = 1;
  let historyError = null;
  const batcher = createMessageBatcher({
    flushMs: 200,
    maxBatchSize: 200,
    emitBatch: rows => {
      if (db) {
        try { saveReceivedHistory(db, rows); }
        catch (error) {
          historyError = error;
          for (const connId of new Set(rows.map(row => row.connId))) {
            const handle = clients.get(connId);
            if (handle) void stopHandle(connId, handle, { force: true, reason: 'history persistence failed', emitStatus: false });
            sendStatus(connId, 'error', { source: 'storage', code: 'HISTORY_WRITE_FAILED', reason: errorMessage(error, 'History write failed') });
          }
          throw error;
        }
      }
      send(IPC_CHANNELS.mqttMessages, rows);
    },
    schedule: scheduleBatch,
    clear: clearBatch,
  });

  function flushMessages() {
    let result = false;
    // Delivery retries may leave another batch behind them. Stop reception first
    // when closing, then commit every remaining batch before deleting/closing DB.
    while (batcher.size > 0) {
      result = batcher.flush();
      if (historyError) throw historyError;
    }
    if (historyError) throw historyError;
    return result;
  }

  function sendStatus(connId, status, details = {}) {
    try {
      send(IPC_CHANNELS.mqttStatus, createMqttStatus(connId, status, details));
      return null;
    } catch (error) {
      return error;
    }
  }

  function validateConnection(connection) {
    if (connection === null || typeof connection !== 'object') return 'connection is required';
    if (nonblankString(connection.id) === null) return 'connection id is required';
    if (nonblankString(connection.host) === null) return 'host is required';
    const port = Number(connection.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'port must be between 1 and 65535';
    const protocol = String(connection.protocol || 'mqtt').replace(/:\/\/$/, '');
    if (!['mqtt', 'mqtts', 'ws', 'wss'].includes(protocol)) return 'unsupported MQTT protocol';
    return null;
  }

  function activeHandle(connId) {
    const id = nonblankString(connId);
    return id === null ? null : clients.get(id) || null;
  }

  function endClient(handle, force) {
    if (handle.endPromise) return handle.endPromise;
    let resolveEnd;
    handle.endPromise = new Promise(resolve => { resolveEnd = resolve; });
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { clearTimer(timer); } catch { /* End settlement must continue. */ }
      resolveEnd();
    };
    try { timer = setTimer(finish, MQTT_END_TIMEOUT_MS); } catch { finish(); }
    try {
      handle.client.end(force, finish);
    } catch {
      finish();
    }
    return handle.endPromise;
  }

  function stopHandle(connId, handle, { force, reason, emitStatus }) {
    if (handle.stopPromise) return handle.stopPromise;
    let resolveStop;
    handle.stopPromise = new Promise(resolve => { resolveStop = resolve; });
    if (clients.get(connId) === handle) clients.delete(connId);
    handle.stopped = true;
    try { handle.settle?.({ ok: false, error: reason }); } catch { /* Keep stopping. */ }
    try { handle.cleanupListeners?.(); } catch { /* Keep stopping. */ }
    Promise.resolve(endClient(handle, force)).then(resolveStop, resolveStop);
    if (emitStatus) {
      sendStatus(connId, 'disconnected', {
        source: 'user',
        code: handle.connectedOnce ? 'USER_DISCONNECTED' : 'USER_CANCELLED',
        reason: handle.connectedOnce ? 'connection closed by user' : 'connection cancelled by user',
        attempt: handle.retryAttempt,
        disconnectedAt: handle.outageStartedAt,
      });
    }
    return handle.stopPromise;
  }

  async function connect(connection) {
    try {
      const validationError = validateConnection(connection);
      if (validationError) return { ok: false, error: validationError };
      const url = buildBrokerUrl(connection);
      const connId = connection.id;
      const previous = clients.get(connId);
      if (previous) {
        void stopHandle(connId, previous, {
          force: true,
          reason: 'connection replaced',
          emitStatus: false,
        });
      }
      const configuredClientId = connection.clientId ?? connection.client_id;
      const configuredCleanSession = connection.cleanSession ?? connection.clean_session;
      const client = mqtt.connect(url, {
        // MQTT.js rebuilds WS URLs from a hostname without IPv6 brackets.
        // Preserve the validated endpoint and keep query parameters out of client options.
        ...(url.startsWith('ws') ? { transformWsUrl: () => url, query: {} } : {}),
        clientId: nonblankString(configuredClientId) || `ineed-${now()}`,
        username: nonblankString(connection.username) || undefined,
        password: typeof connection.password === 'string' && connection.password !== ''
          ? connection.password
          : undefined,
        keepalive: Number(connection.keepalive) || 60,
        clean: configuredCleanSession !== false && configuredCleanSession !== 0,
        connectTimeout: 10_000,
        reconnectPeriod: connection.autoReconnect === false ? 0 : 1_000,
        resubscribe: false,
      });
      const handle = {
        client,
        generation: nextGeneration++,
        stopped: false,
        connectedOnce: false,
        outageStartedAt: null,
        retryAttempt: 0,
        lastDiagnostic: null,
        endPromise: null,
        listeners: [],
        settle: null,
        stopPromise: null,
      };
      clients.set(connId, handle);
      const isCurrent = () => clients.get(connId) === handle && !handle.stopped;
      const listen = (eventName, listener) => {
        const containedListener = (...args) => {
          try {
            listener(...args);
          } catch (error) {
            if (!isCurrent()) return;
            const diagnostic = classifyMqttError(error);
            void stopHandle(connId, handle, {
              force: true,
              reason: errorMessage(error, 'MQTT event failed'),
              emitStatus: false,
            });
            sendStatus(connId, 'error', diagnostic);
          }
        };
        client.on(eventName, containedListener);
        handle.listeners.push([eventName, containedListener]);
      };
      handle.cleanupListeners = () => {
        for (const [eventName, listener] of handle.listeners.splice(0)) {
          client.removeListener?.(eventName, listener);
        }
        // EventEmitter treats a late error with no listener as an uncaught exception.
        if (typeof client.listenerCount !== 'function' || client.listenerCount('error') === 0) {
          client.on('error', () => {});
        }
      };
      const connectingDeliveryError = sendStatus(
        connId, 'connecting', { source: 'client', code: 'CONNECTING' },
      );
      if (connectingDeliveryError) {
        void stopHandle(connId, handle, {
          force: true,
          reason: errorMessage(connectingDeliveryError, 'MQTT status delivery failed'),
          emitStatus: false,
        });
        return {
          ok: false,
          error: errorMessage(connectingDeliveryError, 'MQTT status delivery failed'),
        };
      }

      return await new Promise(resolve => {
        let settled = false;
        const settle = result => {
          if (settled) return;
          settled = true;
          clearTimer(connectTimer);
          resolve(result);
        };
        handle.settle = settle;
        const connectTimer = setTimer(() => {
          if (isCurrent()) {
            const diagnostic = classifyMqttError('MQTT connection timeout');
            void stopHandle(connId, handle, {
              force: true,
              reason: 'timeout',
              emitStatus: false,
            });
            sendStatus(connId, 'error', diagnostic);
          }
          settle({ ok: false, error: 'timeout' });
        }, MQTT_CONNECT_TIMEOUT_MS);

        const terminateWithError = (error, diagnostic = classifyMqttError(error)) => {
          if (!isCurrent()) return;
          handle.lastDiagnostic = diagnostic;
          void stopHandle(connId, handle, {
            force: true,
            reason: errorMessage(error, 'MQTT connection failed'),
            emitStatus: false,
          });
          sendStatus(connId, 'error', diagnostic);
        };
        const sendActiveStatus = (status, details) => {
          const deliveryError = sendStatus(connId, status, details);
          if (!deliveryError) return true;
          if (isCurrent()) {
            void stopHandle(connId, handle, {
              force: true,
              reason: errorMessage(deliveryError, 'MQTT status delivery failed'),
              emitStatus: false,
            });
          }
          return false;
        };

        listen('connect', () => {
          if (!isCurrent()) return;
          const reconnected = handle.connectedOnce;
          if (!sendActiveStatus('connected', {
            reconnected,
            attempt: handle.retryAttempt,
            disconnectedAt: handle.outageStartedAt,
          })) return;
          handle.connectedOnce = true;
          handle.outageStartedAt = null;
          handle.retryAttempt = 0;
          handle.lastDiagnostic = null;
          settle({ ok: true });
        });
        listen('message', (topic, payload, packet = {}) => {
          if (!isCurrent()) return;
          const payloadBytes = typeof payload === 'string'
            ? Buffer.byteLength(payload, 'utf8')
            : Number(payload?.byteLength ?? payload?.length);
          if (Number.isFinite(payloadBytes) && payloadBytes > MQTT_INBOUND_MAX_BYTES) {
            sendActiveStatus('error', {
              source: 'client',
              code: 'PAYLOAD_TOO_LARGE',
              reason: `Inbound MQTT payload exceeds ${MQTT_INBOUND_MAX_BYTES} bytes`,
            });
            return;
          }
          const bytes = Buffer.from(payload);
          batcher.enqueue({
            connId,
            topic: String(topic),
            payload: Array.from(bytes),
            payloadText: bytes.toString('utf8'),
            qos: normalizeQos(packet.qos) ?? 0,
            retained: Boolean(packet.retain),
            timestamp: now(),
          });
        });
        listen('reconnect', () => {
          if (!isCurrent() || !handle.connectedOnce) return;
          if (handle.outageStartedAt === null) handle.outageStartedAt = now();
          handle.retryAttempt += 1;
          sendActiveStatus('reconnecting', {
            ...(handle.lastDiagnostic || classifyMqttError('connection lost')),
            attempt: handle.retryAttempt,
            nextDelayMs: 1_000,
            disconnectedAt: handle.outageStartedAt,
          });
        });
        for (const eventName of ['offline', 'close']) {
          listen(eventName, () => {
            if (!isCurrent() || !handle.connectedOnce) return;
            const diagnostic = classifyMqttError(eventName === 'offline' ? 'offline' : 'connection closed');
            handle.lastDiagnostic = diagnostic;
            if (connection.autoReconnect === false) {
              terminateWithError(diagnostic.reason, diagnostic);
            } else {
              if (handle.outageStartedAt === null) handle.outageStartedAt = now();
              sendActiveStatus('reconnecting', {
                ...diagnostic,
                attempt: handle.retryAttempt,
                disconnectedAt: handle.outageStartedAt,
              });
            }
          });
        }
        listen('error', error => {
          if (!isCurrent()) return;
          const diagnostic = classifyMqttError(error);
          handle.lastDiagnostic = diagnostic;
          if (
            !handle.connectedOnce
            && (
              connection.autoReconnect === false
              ||
              ['broker', 'client'].includes(diagnostic.source)
            )
          ) {
            terminateWithError(error, diagnostic);
          } else if (handle.connectedOnce && connection.autoReconnect !== false) {
            if (handle.outageStartedAt === null) handle.outageStartedAt = now();
            sendActiveStatus('reconnecting', {
              ...diagnostic,
              attempt: handle.retryAttempt,
              disconnectedAt: handle.outageStartedAt,
            });
          } else if (handle.connectedOnce) {
            terminateWithError(error, diagnostic);
          }
        });
      });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async function disconnect(connId, { force = false } = {}) {
    const id = nonblankString(connId);
    if (id === null) return { ok: false, error: 'connection id is required' };
    const handle = clients.get(id);
    if (handle) {
      await stopHandle(id, handle, { force: Boolean(force), reason: 'cancelled', emitStatus: true });
    } else {
      sendStatus(id, 'disconnected', { source: 'user', code: 'USER_CANCELLED' });
    }
    if (db) flushMessages();
    return { ok: true };
  }

  function callbackOperation(connId, topic, operation, timeoutError) {
    const id = nonblankString(connId);
    if (id === null) return Promise.resolve({ ok: false, error: 'connection id is required' });
    const normalizedTopic = nonblankString(topic);
    if (normalizedTopic === null) return Promise.resolve({ ok: false, error: 'topic is required' });
    const handle = activeHandle(id);
    if (!handle) return Promise.resolve({ ok: false, error: 'not connected' });
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (clients.get(id) !== handle) {
          resolve({
            ok: false,
            error: clients.has(id) ? 'connection replaced' : 'not connected',
          });
        } else {
          resolve(result);
        }
      };
      const timer = setTimer(() => finish({ ok: false, error: timeoutError }), MQTT_OPERATION_TIMEOUT_MS);
      try {
        operation(handle.client, normalizedTopic, finish);
      } catch (error) {
        finish({ ok: false, error: errorMessage(error) });
      }
    });
  }

  function subscribe(connId, topic, qos) {
    const normalizedQos = normalizeQos(qos);
    if (normalizedQos === null) return Promise.resolve({ ok: false, error: 'qos must be 0, 1, or 2' });
    return callbackOperation(connId, topic, (client, value, finish) => {
      client.subscribe(value, { qos: normalizedQos }, (error, granted) => {
        if (error) finish({ ok: false, error: errorMessage(error) });
        else finish({ ok: true, granted: Array.isArray(granted) ? granted : [] });
      });
    }, 'subscribe timeout');
  }

  function unsubscribe(connId, topic) {
    return callbackOperation(connId, topic, (client, value, finish) => {
      client.unsubscribe(value, error => {
        finish(error ? { ok: false, error: errorMessage(error) } : { ok: true });
      });
    }, 'unsubscribe timeout');
  }

  function publish(connId, topic, payload, qos, retain) {
    const publishTopic = nonblankString(topic);
    if (publishTopic === null) return Promise.resolve({ ok: false, error: 'topic is required' });
    // MQTT topic names cannot use subscription wildcards. Reject before the
    // client reports a QoS 0 send as successful and the broker closes its socket.
    if (/[+#]|\p{Cc}/u.test(publishTopic) || Buffer.byteLength(publishTopic, 'utf8') > 65_535) {
      return Promise.resolve({ ok: false, error: 'invalid MQTT publish topic' });
    }
    const normalizedQos = normalizeQos(qos);
    if (normalizedQos === null) return Promise.resolve({ ok: false, error: 'qos must be 0, 1, or 2' });
    let normalizedPayload;
    if (typeof payload === 'string') {
      normalizedPayload = payload;
    } else if (
      Array.isArray(payload)
      && payload.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      normalizedPayload = Buffer.from(payload);
    } else {
      return Promise.resolve({ ok: false, error: 'payload must be a string or byte array' });
    }
    return callbackOperation(connId, topic, (client, value, finish) => {
      client.publish(value, normalizedPayload, { qos: normalizedQos, retain: Boolean(retain) }, error => {
        finish(error ? { ok: false, error: errorMessage(error) } : { ok: true });
      });
    }, 'publish timeout');
  }

  async function disconnectAll({ force = false, strict = false } = {}) {
    const pending = [...clients.entries()].map(([connId, handle]) => (
      stopHandle(connId, handle, { force: Boolean(force), reason: 'shutdown', emitStatus: false })
    ));
    const results = await Promise.allSettled(pending);
    if (strict && results.some(result => result.status === 'rejected')) throw new Error('MQTT disconnect failed');
    if (db && !historyError) flushMessages();
    if (strict && historyError) throw historyError;
  }

  return Object.freeze({
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    publish,
    disconnectAll,
    flush: flushMessages,
    dispose: () => batcher.dispose(),
    get size() { return clients.size; },
  });
}

module.exports = { createMqttCoordinator };
