const STORAGE_FIELDS = [
  'messageCount',
  'logCount',
  'publishCount',
  'databaseBytes',
  'walBytes',
  'shmBytes',
  'totalBytes'
];

function toFiniteNonnegativeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export function normalizeStorageStats(value = {}) {
  const stats = Object.fromEntries(STORAGE_FIELDS.map(field => [field, toFiniteNonnegativeNumber(value[field])]));
  const computedTotalCount = stats.messageCount + stats.logCount + stats.publishCount;
  stats.totalCount = value.totalCount == null || value.totalCount === ''
    ? computedTotalCount
    : toFiniteNonnegativeNumber(value.totalCount, computedTotalCount);
  return {
    messageCount: stats.messageCount,
    logCount: stats.logCount,
    publishCount: stats.publishCount,
    totalCount: stats.totalCount,
    databaseBytes: stats.databaseBytes,
    walBytes: stats.walBytes,
    shmBytes: stats.shmBytes,
    totalBytes: stats.totalBytes
  };
}

export function formatStorageBytes(value) {
  const bytes = toFiniteNonnegativeNumber(value);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unitIndex = -1;
  do {
    amount /= 1024;
    unitIndex += 1;
  } while (amount >= 1024 && unitIndex < units.length - 1);
  return `${Number(amount.toFixed(2))} ${units[unitIndex]}`;
}
