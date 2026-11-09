// Strict update preparation is separate from best-effort ordinary window closing.
export async function prepareUpdate({ drain, disconnect, writers, timeoutMs = 20_000 }) {
  let timer;
  const controller = new AbortController();
  const { signal } = controller;
  try {
    await Promise.race([
      (async () => {
        await drain();
        signal.throwIfAborted();
        await disconnect(signal);
        signal.throwIfAborted();
        await Promise.all(writers.map(writer => writer.flushStrict()));
      })(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('更新前数据保存超时')), timeoutMs); }),
    ]);
  } finally { controller.abort(); clearTimeout(timer); }
}
