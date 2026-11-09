import {
  normalizeMessageBatch,
  normalizeMqttStatus,
} from '@ineed-mqtt-tool/mqtt-contract';
import { assertRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';

function ownDataValue(target, key) {
  if (
    target === null
    || (typeof target !== 'object' && typeof target !== 'function')
  ) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function assertFunction(value, message) {
  if (typeof value !== 'function') throw new TypeError(message);
}

function assertHandler(handler) {
  assertFunction(handler, 'event handler must be a function');
}

function toTauriPublishPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Array.from(payload);

  throw new TypeError('Tauri MQTT payload must be a string or Uint8Array');
}

function toTauriConnection(conn) {
  const { client_id, clean_session, auto_reconnect, ...canonical } = conn;
  // Edited runtime rows can contain both DB and UI names. Serde rejects duplicates.
  for (const [key, savedValue] of [
    ['clientId', client_id],
    ['cleanSession', clean_session],
    ['autoReconnect', auto_reconnect],
  ]) {
    const value = canonical[key] ?? savedValue;
    if (value !== undefined) canonical[key] = value;
  }
  return canonical;
}

function decodePayloadHex(payloadHex) {
  if (
    typeof payloadHex !== 'string'
    || payloadHex.length % 2 !== 0
    || !/^[0-9a-f]*$/i.test(payloadHex)
  ) {
    throw new TypeError(
      'Tauri MQTT payloadHex must be an even-length hexadecimal string',
    );
  }

  const bytes = new Uint8Array(payloadHex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(payloadHex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function normalizeTauriMessageBatch(input) {
  const messages = Array.isArray(input) ? input : [input];
  const structured = messages.map((message) => {
    const payload = message.payloadHex === undefined
      ? message.payload
      : decodePayloadHex(message.payloadHex);
    const timestamp = message.timestamp === undefined
      ? Date.parse(message.time)
      : message.timestamp;
    const normalized = {
      connId: message.connId,
      payload,
      qos: message.qos,
      retained: message.retained,
      timestamp,
      topic: message.topic,
    };
    const payloadText = message.payloadText === undefined
      ? (typeof message.payload === 'string' ? message.payload : undefined)
      : message.payloadText;

    if (message.historyPersisted === true) normalized.historyPersisted = true;
    if (payloadText !== undefined) normalized.payloadText = payloadText;
    return normalized;
  });

  return normalizeMessageBatch(structured);
}

function readRequestId(request) {
  try {
    const requestId = request?.requestId;
    return typeof requestId === 'string' && requestId.trim() !== ''
      ? requestId
      : null;
  } catch {
    return null;
  }
}

function normalizeBeforeCloseError(error) {
  let message = 'Before-close handler failed';

  try {
    const candidate = error?.message ?? error;
    if (candidate != null) message = String(candidate);
  } catch {
    // Keep the stable fallback for hostile rejected values.
  }

  return message;
}

export function createTauriRuntimeAdapter(dependencies) {
  const invoke = ownDataValue(dependencies, 'invoke');
  const listen = ownDataValue(dependencies, 'listen');
  const readText = ownDataValue(dependencies, 'readText');
  const writeText = ownDataValue(dependencies, 'writeText');

  assertFunction(invoke, 'Tauri invoke must be a function');
  assertFunction(listen, 'Tauri listen must be a function');
  assertFunction(readText, 'Tauri clipboard readText must be a function');
  assertFunction(writeText, 'Tauri clipboard writeText must be a function');

  const invokeCommand = (command, args) => (
    args === undefined
      ? Reflect.apply(invoke, dependencies, [command])
      : Reflect.apply(invoke, dependencies, [command, args])
  );
  const claimedBeforeCloseRequestIds = new Set();
  let activeBeforeCloseDispose = null;

  function addListener(event, handler, normalizePayload) {
    assertHandler(handler);
    const listener = eventData => handler(normalizePayload(eventData.payload));
    const pendingUnlisten = Promise.resolve(
      Reflect.apply(listen, dependencies, [event, listener]),
    ).then((unlisten) => {
      if (typeof unlisten !== 'function') {
        throw new TypeError(
          `Tauri listen("${event}") must resolve to an unlisten function`,
        );
      }
      return unlisten;
    });
    let disposal;

    void pendingUnlisten.catch(() => {});
    return () => {
      if (!disposal) {
        disposal = pendingUnlisten.then(unlisten => Reflect.apply(unlisten, undefined, []));
      }
      return disposal;
    };
  }

  async function acknowledgeBeforeClose(payload) {
    try {
      await invokeCommand('window_close_ready', payload);
    } catch {
      // The native window may already be gone; never leak an ACK failure.
    }
  }

  function onBeforeClose(handler) {
    assertHandler(handler);
    if (activeBeforeCloseDispose !== null) {
      throw new Error('before-close handler is already registered');
    }

    const disposeNative = addListener(
      'app:before-close',
      async (request) => {
        const requestId = readRequestId(request);
        if (
          requestId === null
          || claimedBeforeCloseRequestIds.has(requestId)
        ) return;
        claimedBeforeCloseRequestIds.add(requestId);

        let acknowledgment;
        try {
          await handler(request);
          acknowledgment = { requestId, ok: true, error: null };
        } catch (error) {
          acknowledgment = {
            requestId,
            ok: false,
            error: normalizeBeforeCloseError(error),
          };
        }
        if (request.purpose === 'update') {
          try { await invokeCommand('update_prepare_ready', acknowledgment); }
          catch { /* A timed out or destroyed native window owns the failure. */ }
        } else {
          await acknowledgeBeforeClose(acknowledgment);
        }
      },
      payload => payload,
    );
    let disposal;
    const dispose = () => {
      if (!disposal) {
        disposal = disposeNative().finally(() => {
          if (activeBeforeCloseDispose === dispose) activeBeforeCloseDispose = null;
        });
      }
      return disposal;
    };

    activeBeforeCloseDispose = dispose;
    return dispose;
  }

  const adapter = {
    runtimeName: 'tauri',
    connection: {
      list: () => invokeCommand('db_get_connections'),
      save: conn => invokeCommand('db_save_connection', { conn }),
      delete: id => invokeCommand('db_delete_connection', { id }),
      messageCounts: () => invokeCommand('db_get_message_counts'),
    },
    subscription: {
      list: connId => invokeCommand('db_get_subscriptions', { connId }),
      add: sub => invokeCommand('db_add_subscription', { sub }),
      remove: id => invokeCommand('db_remove_subscription', { id }),
    },
    mqtt: {
      connect: conn => (
        invokeCommand('mqtt_connect', { conn: toTauriConnection(conn) })
      ),
      disconnect: connId => invokeCommand('mqtt_disconnect', { connId }),
      subscribe: (connId, topic, qos) => (
        invokeCommand('mqtt_subscribe', { connId, topic, qos })
      ),
      unsubscribe: (connId, topic) => (
        invokeCommand('mqtt_unsubscribe', { connId, topic })
      ),
      publish: (connId, topic, payload, qos, retain) => (
        invokeCommand('mqtt_publish', {
          connId,
          topic,
          payload: toTauriPublishPayload(payload),
          qos,
          retain,
        })
      ),
      onMessages: handler => addListener(
        'mqtt:messages',
        handler,
        normalizeTauriMessageBatch,
      ),
      onStatus: handler => addListener(
        'mqtt:status',
        handler,
        normalizeMqttStatus,
      ),
    },
    history: {
      saveMessages: rows => invokeCommand('db_save_messages', { rows }),
      saveLogs: rows => invokeCommand('db_save_logs', { rows }),
      queryMessages: filter => invokeCommand('db_query_history_messages', { filter }),
      deleteMessage: id => invokeCommand('db_delete_history_message', { id }),
      clearMessages: filter => invokeCommand('db_clear_history_messages', { filter }),
      queryLogs: filter => invokeCommand('db_query_history_logs', { filter }),
      deleteLog: id => invokeCommand('db_delete_history_log', { id }),
      clearLogs: filter => invokeCommand('db_clear_history_logs', { filter }),
    },
    publishHistory: {
      list: (connId, limit) => invokeCommand('db_get_publish_history', { connId, limit }),
      save: msg => invokeCommand('db_save_publish', { msg }),
    },
    settings: {
      getAll: () => invokeCommand('db_get_all_settings'),
      save: (key, value) => invokeCommand('db_save_setting', { key, value: String(value) }),
    },
    storage: {
      stats: () => invokeCommand('db_get_storage_stats'),
      clearHistory: () => invokeCommand('db_clear_history_storage'),
    },
    clipboard: {
      readText: () => Reflect.apply(readText, dependencies, []),
      writeText: value => Reflect.apply(writeText, dependencies, [value]),
    },
    window: {
      openHistory: (kind, connId) => (
        invokeCommand('window_open_history', { kind, connId })
      ),
      openExternal: url => invokeCommand('window_open_external', { url }),
    },
    lifecycle: {
      onBeforeClose,
    },
    update: {
      check: () => invokeCommand('update_check', {}),
      getState: () => invokeCommand('update_state'),
      download: () => invokeCommand('update_download'),
      cancel: () => invokeCommand('update_cancel'),
      install: () => invokeCommand('update_install'),
      onState: handler => addListener('update:changed', handler, payload => payload),
    },
  };

  return assertRuntimeAdapter(adapter);
}
