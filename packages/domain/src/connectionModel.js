import { isValidMqttHost, normalizeWebSocketPath } from '@ineed-mqtt-tool/mqtt-contract/endpoint';

export const protocolOptions = ['mqtt://', 'mqtts://', 'ws://', 'wss://'];

export const defaultPorts = {
  'mqtt://': 1883,
  'mqtts://': 8883,
  'ws://': 8083,
  'wss://': 8084
};

export function normalizeRuntimeConnection(conn) {
  return {
    ...conn,
    status: 'disconnected',
    messagesIn: 0,
    messagesOut: 0,
    protocol: (conn.protocol || 'mqtt').replace(/:\/\/$/, '') + '://'
  };
}

export function incrementConnectionMessageCount(connections = [], connId, direction) {
  const connection = connections.find(item => item.id === connId);
  if (!connection) return;
  const key = direction === 'out' ? 'messagesOut' : 'messagesIn';
  connection[key] = (connection[key] || 0) + 1;
}

export function applyPersistedMessageCounts(connections = [], counts = []) {
  const countsByConnection = new Map(counts.map(row => [row.connection_id, row]));
  for (const connection of connections) {
    const row = countsByConnection.get(connection.id);
    connection.messagesIn = Number(row?.messages_in || 0);
    connection.messagesOut = Number(row?.messages_out || 0);
  }
}

export function normalizeSubscription(sub) {
  return {
    ...sub,
    connId: sub.connection_id,
    color: sub.color || '',
    messageCount: 0,
    format: sub.format || 'json',
    status: 'inactive'
  };
}

export function toDbConnection(conn) {
  return {
    id: conn.id,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    protocol: (conn.protocol || 'mqtt://').replace(/:\/\/$/, ''),
    path: conn.path || '',
    client_id: conn.clientId ?? conn.client_id ?? '',
    username: conn.username || '',
    password: conn.password || '',
    ssl: conn.ssl ? 1 : 0,
    keepalive: conn.keepalive || 60,
    clean_session: (conn.cleanSession ?? conn.clean_session ?? 1) ? 1 : 0,
    sort_order: conn.sort_order || 0
  };
}

export function createNewConnectionDraft(keepalive = 60, cleanSession = true) {
  return { name: '', host: 'localhost', port: 1883, protocol: 'mqtt://', path: '', clientId: '', username: '', password: '', keepalive, cleanSession: cleanSession ? 1 : 0 };
}

export function createEditConnectionDraft(conn) {
  const proto = conn.protocol?.includes('://') ? conn.protocol : ((conn.protocol || 'mqtt') + (conn.ssl ? 's://' : '://'));
  return {
    name: conn.name,
    host: conn.host,
    port: conn.port,
    protocol: proto,
    path: conn.path || '',
    clientId: conn.clientId ?? conn.client_id ?? '',
    username: conn.username || '',
    password: conn.password || '',
    keepalive: conn.keepalive || 60
  };
}

export function createConnectionFromDraft(draft, sortOrder) {
  return {
    id: 'conn-' + Date.now(),
    ...draft,
    status: 'disconnected',
    subscriptions: 0,
    messagesIn: 0,
    messagesOut: 0,
    description: '',
    lastActive: '',
    cleanSession: (draft.cleanSession ?? 1) ? 1 : 0,
    sort_order: sortOrder
  };
}

export function cloneConnectionModel(conn, sortOrder) {
  return {
    ...conn,
    id: 'conn-' + Date.now(),
    name: conn.name + ' 副本',
    status: 'disconnected',
    subscriptions: 0,
    messagesIn: 0,
    messagesOut: 0,
    lastActive: '',
    sort_order: sortOrder
  };
}

export function validateConnectionDraft(draft, field) {
  const e = {};
  if (!field || field === 'name') {
    if (!draft.name.trim()) e.name = '连接名称不能为空';
  }
  if (!field || field === 'host') {
    if (!draft.host.trim()) e.host = '主机地址不能为空';
    else if (!isValidMqttHost(draft.host)) e.host = '主机地址格式不正确';
  }
  if ((!field || field === 'path') && ['ws', 'ws://', 'wss', 'wss://'].includes(draft.protocol)) {
    try { normalizeWebSocketPath(draft.path ?? ''); } catch (error) { e.path = error.message; }
  }
  if (!field || field === 'port') {
    if (!isIntegerInRange(draft.port, 1, 65535)) e.port = '端口必须为 1-65535 的整数';
  }
  if (!field || field === 'keepalive') {
    if (!isIntegerInRange(draft.keepalive, 10, 3600)) e.keepalive = '必须为 10-3600 秒的整数';
  }
  return e;
}

function isIntegerInRange(value, min, max) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return false;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max;
}
