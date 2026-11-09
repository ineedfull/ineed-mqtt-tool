'use strict';

function createMessageBatcher({
  flushMs = 50,
  maxBatchSize = 100,
  maxEmitRetries = 1,
  emitBatch,
  onError = () => {},
  onDrop = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  clear = timer => clearTimeout(timer),
} = {}) {
  if (!Number.isFinite(flushMs) || flushMs < 0) {
    throw new TypeError('flushMs must be a non-negative finite number');
  }
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new TypeError('maxBatchSize must be a positive integer');
  }
  if (!Number.isInteger(maxEmitRetries) || maxEmitRetries < 0) {
    throw new TypeError('maxEmitRetries must be a non-negative integer');
  }
  if (typeof emitBatch !== 'function') {
    throw new TypeError('emitBatch must be a function');
  }

  let queue = [];
  let retryBatch = null;
  let timer = null;
  let disposed = false;

  function clearTimer() {
    if (timer === null) return;
    clear(timer);
    timer = null;
  }

  function flush() {
    clearTimer();
    if (disposed || (retryBatch === null && queue.length === 0)) return false;
    const state = retryBatch || { attempt: 0, rows: queue };
    retryBatch = null;
    if (state.rows === queue) queue = [];
    try {
      emitBatch(state.rows);
    } catch (error) {
      state.attempt += 1;
      try {
        onError(error, state.rows, {
          attempt: state.attempt,
          maxRetries: maxEmitRetries,
        });
      } catch {
        // Error reporting must not break the bounded delivery policy.
      }
      if (state.attempt <= maxEmitRetries) {
        retryBatch = state;
      } else {
        try { onDrop(state.rows, error); } catch { /* Keep drops contained. */ }
      }
      if (retryBatch !== null || queue.length > 0) timer = schedule(flush, flushMs);
      return false;
    }
    if (queue.length > 0) timer = schedule(flush, flushMs);
    return true;
  }

  return Object.freeze({
    enqueue(message) {
      if (disposed) return false;
      queue.push(message);
      if (retryBatch === null && queue.length >= maxBatchSize) {
        flush();
      } else if (timer === null) {
        timer = schedule(flush, flushMs);
      }
      return true;
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      queue = [];
      retryBatch = null;
    },
    get size() {
      return queue.length + (retryBatch?.rows.length || 0);
    },
  });
}

module.exports = { createMessageBatcher };
