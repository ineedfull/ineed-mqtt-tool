/* global window, document, getComputedStyle */
// Loaded as a classic injected script; the native driver calls this global.
/* Test-only driver loaded into the production renderer in two native desktops. */
// eslint-disable-next-line no-unused-vars
async function installDesktopSoak(config) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async predicate => {
    const end = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > end) throw new Error('DOM wait timed out'); await delay(50); }
  };
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  const click = async text => { await wait(() => button(text) && !button(text).disabled); button(text).click(); await delay(100); };
  const setValue = (el, value) => {
    if (!el) throw new Error('missing input');
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const state = { received: 0, gaps: 0, duplicates: 0, last: 0, invalidPayload: 0, errors: [], stalls: [], visibilityEvents: [], started: Date.now(), commands: 0 };
  document.addEventListener('visibilitychange', () => state.visibilityEvents.push({
    visibility: document.visibilityState, received: state.received, time: Date.now(),
  }));
  window.addEventListener('error', event => state.errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
  let lastTick = performance.now();
  setInterval(() => { const now = performance.now(); const lag = now - lastTick - 100; if (lag > 200) state.stalls.push(Math.round(lag)); lastTick = now; }, 100);
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const db = config.runtime === 'electron' ? window.ineedMqtt.db : {
    getMessageCounts: () => invoke('db_get_message_counts'),
    queryHistoryMessages: filter => invoke('db_query_history_messages', { filter }),
    clearHistoryMessages: filter => invoke('db_clear_history_messages', { filter }),
    getStorageStats: () => invoke('db_get_storage_stats'),
  };
  const messages = batch => { for (const m of (Array.isArray(batch) ? batch : [batch])) {
    if (m.topic !== 'desktop-soak/data') continue;
    try {
      const hexText = m.payloadHex === undefined ? undefined : new TextDecoder().decode(new Uint8Array(m.payloadHex.match(/../g).map(x => parseInt(x, 16))));
      const text = m.payloadText ?? hexText ?? (typeof m.payload === 'string' ? m.payload : new TextDecoder().decode(new Uint8Array(m.payload))) ?? '';
      const n = Number(JSON.parse(text).seq);
      if (!Number.isInteger(n) || n < 1) { state.invalidPayload++; continue; }
      if (n <= state.last) state.duplicates++;
      else if (n > state.last + 1) state.gaps += n - state.last - 1;
      state.last = n; state.received++;
    } catch { state.invalidPayload++; }
  } };
  if (config.runtime === 'electron') window.ineedMqtt.mqtt.onMessages(messages);
  else {
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => messages(event.payload));
    await invoke('plugin:event|listen', { event: 'mqtt:messages', target: { kind: 'Any' }, handler });
  }
  await wait(() => document.querySelector('.conn-item'));
  document.querySelector('.conn-item').click();
  await click('连接'); await wait(() => button('断开'));
  document.querySelector('[title="添加订阅"]').click();
  await wait(() => document.querySelector('#sub-topic') || document.querySelector('input[placeholder]'));
  await delay(100);
  const modal = document.querySelector('[role="dialog"]');
  setValue(modal.querySelector('input'), 'desktop-soak/data');
  setValue(modal.querySelector('[aria-label="订阅 QoS"]'), '1');
  await click('确认订阅'); await wait(() => !document.querySelector('[role="dialog"]'));
  if (config.pauseFollow) document.querySelector('.follow-button').click();
  const blockTimer = config.rendererBlockMs > 0 ? setInterval(() => {
    const started = performance.now();
    while (performance.now() - started < config.rendererBlockMs) { /* Test real renderer congestion. */ }
  }, 5000) : null;
  window.desktopSoakCommand = async command => {
    try {
      state.commands++;
      if (command.op === 'exercise') {
        document.querySelector('[title="新建连接"]').click(); await delay(100);
        const dialog = document.querySelector('[role="dialog"]');
        setValue(dialog.querySelector('[aria-label="连接名称"]'), 'invalid draft');
        const port = dialog.querySelector('input#conn-port') || [...dialog.querySelectorAll('input')].find(input => input.value === '1883');
        setValue(port, '1883.5'); await click('创建连接');
        if (!document.querySelector('.modal__err')?.textContent.includes('整数')) throw new Error('invalid port accepted');
        await click('取消');
        document.querySelector('[title="设置"]').click(); await delay(100);
        setValue(document.querySelector('#mqtt-theme'), command.minute % 2 ? 'dark' : 'light');
        document.querySelector('[aria-label="大字模式"]').click(); await click('保存');
        await wait(() => !document.querySelector('[role="dialog"]'));
        document.querySelector('[aria-label="折叠连接列表"]')?.click(); await delay(100);
        document.querySelector('[aria-label="展开连接列表"]')?.click();
        await click('断开'); await wait(() => button('连接')); await click('连接'); await wait(() => button('断开'));
      }
      const history = await db.queryHistoryMessages({ connection_id: 'desktop-soak', page: 1, page_size: 20 });
      const counts = await db.getMessageCounts();
      const stats = await db.getStorageStats();
      const result = { ...state, elapsedMs: Date.now() - state.started, counts, stats, historyTotal: history.total, domMessages: document.querySelectorAll('.chat-msg--in').length,
        assetSources: [...document.scripts].map(script => script.src).filter(Boolean), visibility: document.visibilityState,
        persistenceIpc: { ...window.desktopSoakIpc },
        rootDisplay: getComputedStyle(document.querySelector('.mqtt-app')).display,
        rootWidth: document.querySelector('.mqtt-app').getBoundingClientRect().width,
        latestRenderedSequence: Number(document.querySelector('.chat-msg--in:last-child .chat-msg__bubble')?.textContent.match(/"seq"\s*:\s*(\d+)/)?.[1] || 0),
        followingLatest: document.querySelector('.follow-button')?.getAttribute('aria-pressed') === 'true',
        theme: document.querySelector('.mqtt-app').dataset.theme, largeFont: document.querySelector('.mqtt-app').classList.contains('large-font') };
      if (command.op === 'finish') {
        if (blockTimer !== null) clearInterval(blockTimer);
        await click('断开'); await delay(800);
        result.finalCounts = await db.getMessageCounts();
        await db.clearHistoryMessages({ connection_id: 'desktop-soak' });
        result.afterCleanup = await db.getMessageCounts();
      }
      if (config.runtime === 'tauri') await invoke('desktop_soak_report', { id: command.id, result });
      return result;
    } catch (error) {
      const result = { failed: String(error.stack || error), ...state };
      if (config.runtime === 'tauri') await invoke('desktop_soak_report', { id: command.id, result });
      return result;
    }
  };
  if (config.runtime === 'tauri') await invoke('desktop_soak_report', { id: 'ready', result: { ready: true } });
  return { ready: true };
}
