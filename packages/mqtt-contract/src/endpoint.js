/* global URL, TextEncoder */

// Used by both the connection form and the Electron connection boundary.
export function isValidMqttHost(host) {
  if (typeof host !== 'string' || !host || host.length > 1024) return false;
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (!literal.includes(':') || /[\s/\\?#@%[\]]/.test(literal)) return false;
    try { return new URL(`http://[${literal}]/`).hostname.startsWith('['); }
    catch { return false; }
  }
  return /^[\w.-]+$/.test(host);
}

export function normalizeWebSocketPath(path = '') {
  if (typeof path !== 'string' || new TextEncoder().encode(path).length > 2048 || /[\s#\\]|\p{Cc}/u.test(path)) {
    throw new TypeError('WebSocket 路径格式无效（最多 2048 字节，不含空白、片段或反斜线）');
  }
  return path === '' ? '/mqtt' : path.startsWith('/') ? path : `/${path}`;
}

export function buildBrokerUrl(connection) {
  if (!isValidMqttHost(connection.host)) throw new TypeError('主机地址格式不正确');
  const protocol = String(connection.protocol || 'mqtt').replace(/:\/\/$/, '');
  if (!['mqtt', 'mqtts', 'ws', 'wss'].includes(protocol)) throw new TypeError('unsupported MQTT protocol');
  const port = Number(connection.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be between 1 and 65535');
  const host = connection.host.includes(':') && !connection.host.startsWith('[') ? `[${connection.host}]` : connection.host;
  const path = ['ws', 'wss'].includes(protocol) ? normalizeWebSocketPath(connection.path ?? '') : '';
  return `${protocol}://${host}:${port}${path}`;
}
