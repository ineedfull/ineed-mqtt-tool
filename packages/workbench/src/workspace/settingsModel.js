export const defaultSettings = Object.freeze({
  logLevel: 'debug',
  maxRealtimeMessages: 300,
  maxLogEntries: 300,
  persistReceiveLogs: false,
  autoFormatReceivedJson: true,
  maxAutoFormatPayloadBytes: 65536,
  payloadFormat: 'auto',
  timestampFormat: 'relative',
  autoScroll: true,
  highlightJson: true,
  largeFont: false,
  keepalive: 60,
  defaultQos: 1,
  cleanSession: true,
  autoReconnect: true
});

export function coerceSettingValue(key, value, defaults = defaultSettings) {
  const fallback = defaults[key];
  if (value == null) return fallback;
  if (typeof fallback === 'boolean') return value === true || value === 'true' || value === '1';
  if (typeof fallback === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  return String(value);
}

export function mergeSettings(saved = {}, defaults = defaultSettings) {
  const merged = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (Object.prototype.hasOwnProperty.call(saved || {}, key)) {
      merged[key] = coerceSettingValue(key, saved[key], defaults);
    }
  }
  return merged;
}
