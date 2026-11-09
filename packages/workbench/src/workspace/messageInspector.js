export function originalMessageContent(message) {
  const hex = String(message.payloadHex ?? '').replace(/\s/g, '');
  if (hex && /^(?:[0-9a-f]{2})+$/i.test(hex)) {
    const bytes = Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
    try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), label: '复制原始文本' }; }
    catch { return { text: hex.toUpperCase().match(/../g).join(' '), label: '复制 HEX 字节' }; }
  }
  return { text: String(message.payload ?? ''), label: '复制原始文本' };
}
