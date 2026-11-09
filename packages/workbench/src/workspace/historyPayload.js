const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function normalizeHistoryFormat(format) {
  const normalized = String(format || '').toLowerCase();
  return ['json', 'hex', 'text'].includes(normalized) ? normalized : 'text';
}

function bytesToHex(bytes) {
  return Array.from(bytes || [], byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function formatJson(payload) {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

export function createHistoryPayload({ payload = '', payloadHex = '', bytes, format = 'text' } = {}) {
  const normalizedFormat = normalizeHistoryFormat(format);
  const payloadBytes = payload instanceof Uint8Array ? payload : null;
  const text = payloadBytes ? decoder.decode(payloadBytes) : String(payload ?? '');
  if (normalizedFormat === 'hex') {
    const hex = payloadHex
      ? String(payloadHex).replace(/[^a-f\d]/gi, '').toUpperCase()
      : bytesToHex(bytes || payloadBytes || encoder.encode(text));
    return { payload: hex, format: 'hex' };
  }
  return {
    payload: normalizedFormat === 'json' ? formatJson(text) : text,
    format: normalizedFormat,
  };
}

export function formatStoredHistoryPayload(row = {}) {
  const payload = String(row.payload ?? '');
  if (normalizeHistoryFormat(row.format) !== 'hex') return payload;
  const compact = payload.replace(/[^a-f\d]/gi, '').toUpperCase();
  return compact.match(/.{1,2}/g)?.join(' ') || '';
}
