// UI timestamps use local wall time, independent of the OS language settings.
// Wire/storage timestamps keep their original numeric or ISO representation.
export function formatTimestamp(value) {
  let timestamp = value;
  if (typeof value === 'string') {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return '--';
    // Date.parse normalizes impossible dates (e.g. February 30). Reject them.
    const day = value.slice(0, 10);
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return '--';
    timestamp = Date.parse(value);
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return '--';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '--';
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}`;
}

export function formatClockTime(value) {
  return formatTimestamp(value).split(' ').at(-1);
}
