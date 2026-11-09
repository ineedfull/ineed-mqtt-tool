export function withTimeout(promise, timeoutMs, message) {
  let settled = false;
  let timer;
  let rejectWrapped;

  const wrapped = new Promise((resolve, reject) => {
    rejectWrapped = reject;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    timer = setTimeout(() => {
      settle(reject, new Error(message));
    }, timeoutMs);
    Promise.resolve(promise).then(
      value => settle(resolve, value),
      error => settle(reject, error),
    );
  });

  Object.defineProperty(wrapped, 'cancel', {
    value() {
      if (settled) return;
      const error = new Error('Operation cancelled');
      error.name = 'AbortError';
      settled = true;
      clearTimeout(timer);
      rejectWrapped(error);
    },
  });

  return wrapped;
}
