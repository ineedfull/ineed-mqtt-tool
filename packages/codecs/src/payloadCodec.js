const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodePayload(value, sendMode = 'plain') {
  const text = String(value ?? '');
  const bytes = encoder.encode(text);
  if (sendMode === 'hex') {
    return {
      payload: bytes,
      byteLength: bytes.length
    };
  }

  return {
    payload: text,
    byteLength: bytes.length
  };
}

export function toHexPreview(payload, maxBytes = 24) {
  const bytes = payload instanceof Uint8Array ? payload : encoder.encode(String(payload ?? ''));
  const visible = Array.from(bytes.slice(0, maxBytes));
  const text = visible.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const truncated = bytes.length > maxBytes;
  return {
    text: truncated ? text + ' ...' : text,
    totalBytes: bytes.length,
    truncated
  };
}

export function formatReceivedPayloadPreview(payload, format = 'text', payloadHex = '', options = {}) {
  const sourceBytes = payload instanceof Uint8Array
    ? payload
    : encoder.encode(String(payload ?? ''));
  const text = payload instanceof Uint8Array
    ? decoder.decode(sourceBytes)
    : String(payload ?? '');
  const providedByteLength = Number(options.byteLength);
  const totalBytes = Number.isFinite(providedByteLength) && providedByteLength >= 0
    ? providedByteLength
    : sourceBytes.length;
  const configuredDisplayBytes = Number(options.maxDisplayBytes);
  const maxDisplayBytes = Number.isFinite(configuredDisplayBytes) && configuredDisplayBytes > 0
    ? Math.floor(configuredDisplayBytes)
    : Number.POSITIVE_INFINITY;
  const truncated = totalBytes > maxDisplayBytes;

  if (format === 'hex') {
    const source = payloadHex
      || Array.from(sourceBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const visibleSource = truncated ? source.slice(0, maxDisplayBytes * 2) : source;
    return {
      text: visibleSource.match(/.{1,2}/g)?.map(part => part.toUpperCase()).join(' ') || '',
      totalBytes,
      truncated,
    };
  }

  const visibleText = truncated ? decoder.decode(sourceBytes.slice(0, maxDisplayBytes)) : text;
  if (format === 'json' && !truncated) {
    const autoFormatJson = options.autoFormatJson !== false;
    const maxFormatBytes = Number.isFinite(Number(options.maxFormatBytes)) ? Number(options.maxFormatBytes) : 65536;
    if (!autoFormatJson || totalBytes > maxFormatBytes) {
      return { text, totalBytes, truncated: false };
    }
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), totalBytes, truncated: false };
    } catch {
      return { text, totalBytes, truncated: false };
    }
  }
  return { text: visibleText, totalBytes, truncated };
}

export function formatReceivedPayload(payload, format = 'text', payloadHex = '', options = {}) {
  return formatReceivedPayloadPreview(payload, format, payloadHex, options).text;
}
