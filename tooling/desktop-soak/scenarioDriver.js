/* global window, document */
// Test-only injection into the production desktop renderer. Never bundled.
// eslint-disable-next-line no-unused-vars
async function installDesktopSoak(config) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async predicate => {
    const deadline = performance.now() + 15000;
    while (!predicate()) { if (performance.now() > deadline) {
      if (config.runtime === 'tauri') await window.__TAURI_INTERNALS__.invoke('desktop_soak_report', {id:'ready', result:{failed:'scenario DOM deadline',body:document.body.innerText,html:document.body.innerHTML.slice(0,3000)}});
      throw new Error('scenario DOM deadline');
    } await delay(25); }
  };
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  const click = async text => { await wait(() => button(text) && !button(text).disabled); button(text).click(); await delay(40); };
  const input = (label, value) => {
    const el = document.querySelector(`[aria-label="${label}"]`);
    if (!el) throw new Error(`missing ${label}`);
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
  const db = config.runtime === 'electron' ? window.ineedMqtt.db : {
    getAllSettings: () => invoke('db_get_all_settings'),
  };
  const state = { started: performance.now(), wallStarted: Date.now(), runs: 0, statuses: {}, errors: [], retained: 0, mismatches: 0, duplicateResponsesSent: 0, reconnects: 0 };
  window.addEventListener('error', e => state.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => state.errors.push(String(e.reason)));
  await wait(() => document.querySelector('.conn-item'));
  document.querySelector('.conn-item').click(); await click('连接'); await wait(() => button('断开'));
  await click('场景测试'); await wait(() => document.querySelector('.scenario-panel'));
  const panel = document.querySelector('.scenario-panel');
  const library = async () => JSON.parse((await db.getAllSettings())['mqtt.scenarios.v1'] || '[]');
  const readReport = () => { try { return JSON.parse(panel.querySelector('.scenario-results pre')?.textContent || 'null'); } catch { return null; } };
  input('场景名称', `Native ${config.runtime} scenario acceptance`);
  input('发布主题', `scenario/${config.runtime}/command`);
  input('响应主题', `scenario/${config.runtime}/response`);
  input('请求载荷模板', '{"requestId":"{{requestId}}","command":"read","mode":"pass"}');
  await click('保存场景');
  await wait(() => panel.textContent.includes('场景已保存'));
  let latest;
  async function run(mode) {
    input('场景超时', mode === 'timeout' ? 110 : 2500);
    input('请求载荷模板', JSON.stringify({ requestId: '{{requestId}}', command: 'read', mode }));
    const previousId = readReport()?.runId;
    await click('执行当前草稿');
    if (mode === 'stopped') setTimeout(() => button('停止').click(), 35);
    if (mode === 'connection-loss') setTimeout(() => button('断开').click(), 35);
    await wait(() => readReport()?.runId !== previousId && readReport()?.status !== 'running' && readReport()?.cleanup !== 'pending');
    latest = readReport();
    const expected = mode === 'noisy' ? 'pass' : mode;
    if (latest.status !== expected) throw new Error(`expected ${expected}: ${JSON.stringify(latest)}`);
    let saved;
    const saveDeadline = performance.now() + 10000;
    do {
      saved = JSON.parse((await db.getAllSettings())['mqtt.scenarioReports.v1'] || '[]').find(r => r.runId === latest.runId);
      if (saved && saved.cleanup !== 'pending' && !saved.persistenceError) break;
      if (performance.now() > saveDeadline) throw new Error('report not durably settled');
      await delay(20);
    } while (!saved || saved.cleanup === 'pending' || saved.persistenceError);
    if (mode === 'noisy' && !latest.evidence.some(e => e.reason === 'request-id-mismatch')) throw new Error('wrong ID not recorded');
    state.retained += latest.evidence.filter(e => e.retained).length;
    state.mismatches += latest.evidence.filter(e => e.reason === 'request-id-mismatch').length;
    if (mode === 'noisy') state.duplicateResponsesSent++;
    state.runs++; state.statuses[latest.status] = (state.statuses[latest.status] || 0) + 1;
    if (mode === 'connection-loss') { await wait(() => button('连接')); await click('连接'); await wait(() => button('断开')); await delay(60); state.reconnects++; }
    const settings = await db.getAllSettings();
    if ((JSON.parse(settings['mqtt.pendingUnsubscriptions.desktop-soak'] || '[]')).length) throw new Error('temporary subscription lease remains');
    return saved;
  }
  window.desktopSoakCommand = async command => {
    let result;
    try {
      if (command.op === 'batch') {
        for (const mode of ['pass', 'fail', 'timeout', 'stopped', 'noisy', 'connection-loss']) await run(mode);
      }
      if (command.op === 'desktop') {
        await run('pass');
        await click('导出结果 JSON');
        const reportText = panel.querySelector('[aria-label="导出 JSON 内容"]').value;
        if (JSON.parse(reportText).runId !== latest.runId) throw new Error('UI exported stale report');
        await click('复制 JSON'); await wait(() => panel.textContent.includes('JSON 已复制'));
        const clip = config.runtime === 'electron' ? await window.ineedMqtt.clipboard.readText() : await invoke('plugin:clipboard-manager|read_text');
        if (clip !== reportText) throw new Error('native report clipboard mismatch');
        await click('关闭导出'); await click('导出场景');
        const libraryText = panel.querySelector('[aria-label="导出 JSON 内容"]').value;
        await click('复制 JSON');
        await delay(60);
        const libraryClip = config.runtime === 'electron' ? await window.ineedMqtt.clipboard.readText() : await invoke('plugin:clipboard-manager|read_text');
        if (libraryClip !== libraryText) throw new Error('native library clipboard mismatch');
        await click('关闭导出'); panel.querySelector('details.scenario-import').open = true;
        input('导入场景 JSON', libraryClip); await click('预览导入'); await click('确认导入');
        await wait(() => panel.textContent.includes('场景已导入为独立副本'));
        const [a,b] = await library();
        if (a.id === b.id || a.name !== b.name || a.payloadTemplate !== b.payloadTemplate) throw new Error('raw clipboard import changed scenario');
        result = { reportText, libraryText, importedScenarios: await library(), nativeClipboard: true,
          downloadButton: !!button('下载 JSON 文件') };
      }
      if (command.op === 'finish') { await click('断开'); await delay(100); }
      const settings = await db.getAllSettings();
      const reports = JSON.parse(settings['mqtt.scenarioReports.v1'] || '[]');
      if (reports.some(r => r.cleanup === 'pending' || r.persistenceError)) throw new Error('stored report not settled');
      result = { ...result, ...state, elapsedMs: performance.now() - state.started, reports: reports.length,
        reportIds: reports.map(r => r.runId), libraryCount: (await library()).length,
        visibility: document.visibilityState, width: document.querySelector('.mqtt-app').getBoundingClientRect().width,
        assets: [...document.scripts].map(s => s.src).filter(Boolean), latest: reports[0],
        pending: settings['mqtt.pendingUnsubscriptions.desktop-soak'] || '[]' };
    } catch (e) { result = { failed: String(e.message || e) + '\n' + String(e.stack || ''), ...state }; }
    if (config.runtime === 'tauri') await invoke('desktop_soak_report', { id: command.id, result });
    return result;
  };
  if (config.runtime === 'tauri') await invoke('desktop_soak_report', { id: 'ready', result: { ready: true } });
  return { ready: true };
}
