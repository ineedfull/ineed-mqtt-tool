export function createSettingsPersistence({ persist, onError = () => {} } = {}) {
  if (typeof persist !== 'function') {
    throw new TypeError('persist must be a function');
  }
  if (typeof onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  let tail = Promise.resolve();
  const failed = new Map();

  return {
    enqueue(values) {
      const entries = Object.entries(values || {});
      tail = tail.then(async () => {
        for (const [key, value] of entries) {
          try {
            await persist(key, value);
            failed.delete(key);
          } catch (error) {
            failed.set(key, value);
            try {
              onError(error, key, value);
            } catch {
              // Error reporting must not poison later settings writes.
            }
          }
        }
      });
      return tail;
    },
    flush() {
      return tail;
    },
    async flushStrict() {
      await tail;
      for (const [key, value] of failed) {
        await persist(key, value);
        failed.delete(key);
      }
    },
  };
}
