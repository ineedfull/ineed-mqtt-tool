import { formatTimestamp } from './timeFormat.js';

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function padMillis(value) {
  return String(value || '0').padEnd(3, '0').slice(0, 3);
}

// Existing SQLite rows use local wall time; old rows can contain only a clock.
// This adapter deliberately accepts those stored representations without
// guessing a date or changing the persistence contract.
function normalizeDateParts(value) {
  const formatted = formatTimestamp(value);
  if (formatted !== '--') return formatted;
  if (typeof value !== 'string') return '--';
  const text = value.trim();
  const matched = text.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/);
  if (matched) {
    const normalized = `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}.${padMillis(matched[7])}`;
    // Validate the calendar in UTC, without interpreting a naive legacy value
    // in today's local zone (which could have a DST gap at that wall time).
    const calendar = new Date(`${normalized.replace(' ', 'T')}Z`).toISOString().slice(0, 23).replace('T', ' ');
    return calendar === normalized ? normalized : '--';
  }
  const clock = text.match(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/);
  return clock ? `${clock[1]}:${clock[2]}:${clock[3]}.${padMillis(clock[4])}` : '--';
}

export function toHistoryTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatHistoryTime(row = {}) {
  const createdAt = row.created_at;
  const missingCreatedAt = createdAt == null || (typeof createdAt === 'string' && createdAt.trim() === '');
  return normalizeDateParts(missingCreatedAt ? row.time : createdAt);
}
