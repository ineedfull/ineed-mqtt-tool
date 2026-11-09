export function createBatchedPersistence({
  flushMs = 1000,
  maxBatchSize = 200,
  maxQueueSize = 2000,
  maxRetries = 2,
  persistBatch,
  onError,
  onDrop,
  warn = (...args) => console.warn(...args),
  retryDelay = attempt => new Promise(resolve => setTimeout(resolve, Math.min(1000, 250 * (2 ** (attempt - 1))))),
  schedule = (fn, delay) => setTimeout(fn, delay),
  clear = (timer) => clearTimeout(timer)
} = {}) {
  if (typeof persistBatch !== 'function') {
    throw new TypeError('persistBatch must be a function');
  }
  if (!Number.isFinite(maxBatchSize) || !Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
    throw new TypeError('maxBatchSize must be a positive finite integer');
  }
  if (!Number.isFinite(maxQueueSize) || !Number.isInteger(maxQueueSize) || maxQueueSize <= 0) {
    throw new TypeError('maxQueueSize must be a positive finite integer');
  }
  if (!Number.isFinite(maxRetries) || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('maxRetries must be a nonnegative finite integer');
  }
  if (!Number.isFinite(flushMs) || flushMs < 0) {
    throw new TypeError('flushMs must be a finite nonnegative number');
  }

  const queue = [];
  let timer = null;
  let draining = null;
  let dataLoss = null;

  function clearTimer() {
    if (timer === null) return;
    clear(timer);
    timer = null;
  }

  function safeWarn(...args) {
    try {
      Promise.resolve(warn(...args)).catch(() => {});
    } catch {
      // Warning callbacks must not change persistence behavior.
    }
  }

  async function callGuarded(callback, args, label) {
    try {
      await callback?.(...args);
    } catch (error) {
      safeWarn(`[batchedPersistence] ${label} callback failed:`, error?.message || error);
    }
  }

  async function reportFailedRows(error, rows) {
    dataLoss = error;
    safeWarn('[batchedPersistence] flush failed:', error?.message || error);
    await callGuarded(onError, [error, rows], 'error');
    await callGuarded(onDrop, [rows, { reason: 'persist-failed', error }], 'drop');
  }

  async function persistWithRetry(rows) {
    let attempt = 0;
    while (true) {
      try {
        await persistBatch?.(rows);
        return;
      } catch (error) {
        if (attempt >= maxRetries) {
          await reportFailedRows(error, rows);
          return;
        }
        attempt += 1;
        try {
          await retryDelay(attempt);
        } catch (retryError) {
          await reportFailedRows(retryError, rows);
          return;
        }
      }
    }
  }

  async function drain() {
    while (queue.length) {
      const rows = queue.splice(0, maxBatchSize);
      await persistWithRetry(rows);
    }
  }

  function flush() {
    clearTimer();
    if (draining) return draining;
    if (!queue.length) return Promise.resolve();
    // Join the same drain instead of attaching a Promise per incoming row.
    // Check the settlement window before resolving joined flushes, so rows
    // arriving after drain's last await are included without per-row waiters.
    function settleDrain() {
      if (queue.length) return drain().then(settleDrain);
      draining = null;
    }
    draining = drain().then(settleDrain).catch(error => {
      draining = null;
      if (queue.length) ensureTimer();
      throw error;
    });
    return draining;
  }

  function ensureTimer() {
    if (timer !== null) return;
    timer = schedule(() => flush().catch(error => {
      safeWarn('[batchedPersistence] automatic flush failed:', error?.message || error);
    }), flushMs);
  }

  return {
    enqueue(row) {
      queue.push(row);
      if (queue.length > maxQueueSize) {
        dataLoss = new Error('待写历史曾发生丢失，请重启后再更新');
        const dropped = queue.splice(0, queue.length - maxQueueSize);
        void callGuarded(onDrop, [dropped, { reason: 'queue-overflow' }], 'drop');
      }
      if (queue.length >= maxBatchSize) {
        flush();
        return;
      }
      ensureTimer();
    },
    flush,
    async flushStrict() {
      await flush();
      if (dataLoss) throw dataLoss;
    },
    size() {
      return queue.length;
    }
  };
}
