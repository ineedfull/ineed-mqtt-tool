export function normalizeLimit(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(50000, Math.max(100, Math.floor(numeric)));
}

export function trimRealtimeItems(items, limit) {
  const normalized = normalizeLimit(limit, 1000);
  return items.length > normalized ? items.slice(-normalized) : items;
}

export function appendRealtimeItem(items, item, limit) {
  return trimRealtimeItems([...items, item], limit);
}

export function trimRealtimeItemsByConnection(items, limit) {
  const normalized = normalizeLimit(limit, 1000);
  const counts = new Map();
  const kept = [];

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const connId = items[index]?.connId ?? '';
    const count = counts.get(connId) || 0;
    if (count >= normalized) continue;
    counts.set(connId, count + 1);
    kept.push(items[index]);
  }

  return kept.reverse();
}

export function appendRealtimeItemsByConnection(items, newItems, limit) {
  if (!newItems?.length) return items;
  return trimRealtimeItemsByConnection([...items, ...newItems], limit);
}

let realtimeItemSequence = 0;

export function createRealtimeItemId(prefix = 'item') {
  realtimeItemSequence += 1;
  return prefix + '-' + Date.now() + '-' + realtimeItemSequence;
}
