import { createUnavailableRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UpdateProgress from '../../src/components/UpdateProgress.vue';
import MqttToolShell from '../../src/layouts/MqttToolShell.vue';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';

function connection(id = 'connection-1') {
  return {
    id,
    name: `Connection ${id}`,
    host: `${id}.example.com`,
    port: 1883,
    protocol: 'mqtt',
  };
}

function subscription(id = 'subscription-1', connId = 'connection-1', format = 'text') {
  return {
    id,
    connection_id: connId,
    topic: 'sensors/#',
    qos: 1,
    status: 'active',
    color: '#569cd6',
    format,
  };
}

function createFakeRuntime({
  connections = [connection()],
  subscriptions = [],
  settings = {},
} = {}) {
  const adapter = createUnavailableRuntimeAdapter('shell-test');
  const calls = [];
  let messageHandler = null;
  let statusHandler = null;
  let beforeCloseHandler = null;
  let connectRuntime = async () => ({ ok: true });
  let saveSetting = async () => ({ ok: true });
  let saveMessages = async () => ({ ok: true });
  let saveLogs = async () => ({ ok: true });
  let disconnect = async () => ({ ok: true });
  let unsubscribe = async () => ({ ok: true });
  let removeSubscription = async () => ({ ok: true });
  let deleteConnection = async () => ({ ok: true });
  let getConnections = async () => connections;
  let saveConnection = async () => ({ ok: true });
  let addSubscription = async () => ({ ok: true });
  let subscribe = async () => ({ ok: true });
  let publish = async () => ({ ok: true });
  let savePublish = async () => ({ ok: true });
  let openHistory = async () => ({ ok: true });
  let openExternal = async () => ({ ok: true });
  let checkUpdate = async () => null;
  let getStorageStats = async () => ({});
  let clearHistoryStorage = async () => ({});

  adapter.connection.list = async (...args) => {
    calls.push(['connection.list', ...args]);
    return getConnections(...args);
  };
  adapter.connection.save = async (...args) => {
    calls.push(['connection.save', ...args]);
    return saveConnection(...args);
  };
  adapter.connection.messageCounts = async () => [];
  adapter.connection.delete = async (...args) => {
    calls.push(['connection.delete', ...args]);
    return deleteConnection(...args);
  };
  adapter.subscription.list = async connId => subscriptions.filter(
    item => item.connection_id === connId,
  );
  adapter.subscription.add = async (...args) => {
    calls.push(['subscription.add', ...args]);
    return addSubscription(...args);
  };
  adapter.subscription.remove = async (...args) => {
    calls.push(['subscription.remove', ...args]);
    return removeSubscription(...args);
  };
  adapter.settings.getAll = async () => settings;
  adapter.settings.save = async (...args) => {
    calls.push(['settings.save', ...args]);
    return saveSetting(...args);
  };
  adapter.history.saveMessages = async (...args) => {
    calls.push(['history.saveMessages', ...args]);
    return saveMessages(...args);
  };
  adapter.history.saveLogs = async (...args) => {
    calls.push(['history.saveLogs', ...args]);
    return saveLogs(...args);
  };
  adapter.mqtt.connect = async (...args) => {
    calls.push(['mqtt.connect', ...args]);
    return connectRuntime(...args);
  };
  adapter.mqtt.disconnect = async (...args) => {
    calls.push(['mqtt.disconnect', ...args]);
    return disconnect(...args);
  };
  adapter.mqtt.subscribe = async (...args) => {
    calls.push(['mqtt.subscribe', ...args]);
    return subscribe(...args);
  };
  adapter.mqtt.unsubscribe = async (...args) => {
    calls.push(['mqtt.unsubscribe', ...args]);
    return unsubscribe(...args);
  };
  adapter.mqtt.publish = async (...args) => {
    calls.push(['mqtt.publish', ...args]);
    return publish(...args);
  };
  adapter.mqtt.onMessages = callback => {
    messageHandler = callback;
    return () => { messageHandler = null; };
  };
  adapter.mqtt.onStatus = callback => {
    statusHandler = callback;
    return () => { statusHandler = null; };
  };
  adapter.lifecycle.onBeforeClose = callback => {
    beforeCloseHandler = callback;
    return () => { beforeCloseHandler = null; };
  };
  adapter.window.openHistory = async (...args) => {
    calls.push(['window.openHistory', ...args]);
    return openHistory(...args);
  };
  adapter.window.openExternal = async (...args) => {
    calls.push(['window.openExternal', ...args]);
    return openExternal(...args);
  };
  adapter.update.check = async (...args) => {
    calls.push(['update.check', ...args]);
    return checkUpdate(...args);
  };
  adapter.clipboard.writeText = async (...args) => {
    calls.push(['clipboard.writeText', ...args]);
    return { ok: true };
  };
  adapter.publishHistory.save = async (...args) => {
    calls.push(['publishHistory.save', ...args]);
    return savePublish(...args);
  };
  adapter.storage.stats = async (...args) => {
    calls.push(['storage.stats', ...args]);
    return getStorageStats(...args);
  };
  adapter.storage.clearHistory = async (...args) => {
    calls.push(['storage.clearHistory', ...args]);
    return clearHistoryStorage(...args);
  };

  return {
    adapter,
    calls,
    emitMessages(batch) {
      messageHandler?.(batch);
    },
    emitStatus(event) {
      statusHandler?.(event);
    },
    getBeforeCloseHandler() {
      return beforeCloseHandler;
    },
    hasMessageHandler() {
      return typeof messageHandler === 'function';
    },
    hasStatusHandler() {
      return typeof statusHandler === 'function';
    },
    setSaveSetting(next) { saveSetting = next; },
    setSaveMessages(next) { saveMessages = next; },
    setSaveLogs(next) { saveLogs = next; },
    setDisconnect(next) { disconnect = next; },
    setConnect(next) { connectRuntime = next; },
    setUnsubscribe(next) { unsubscribe = next; },
    setRemoveSubscription(next) { removeSubscription = next; },
    setDeleteConnection(next) { deleteConnection = next; },
    setGetConnections(next) { getConnections = next; },
    setSaveConnection(next) { saveConnection = next; },
    setAddSubscription(next) { addSubscription = next; },
    setSubscribe(next) { subscribe = next; },
    setPublish(next) { publish = next; },
    setSavePublish(next) { savePublish = next; },
    setOpenHistory(next) { openHistory = next; },
    setOpenExternal(next) { openExternal = next; },
    setCheckUpdate(next) { checkUpdate = next; },
    setGetStorageStats(next) { getStorageStats = next; },
    setClearHistoryStorage(next) { clearHistoryStorage = next; },
  };
}

function findButton(wrapper, text) {
  return wrapper.findAll('button').find(button => button.text().includes(text));
}

async function mountShell(runtime, options = {}) {
  const wrapper = shallowMount(MqttToolShell, {
    attachTo: options.attachTo ? globalThis.document.body : undefined,
    global: {
      provide: { [runtimeAdapterKey]: runtime.adapter },
      stubs: { PayloadEditor: true },
    },
  });
  await flushPromises();
  return wrapper;
}

async function connect(wrapper) {
  await wrapper.get('.status-bar__btn').trigger('click');
  await flushPromises();
}

describe('MqttToolShell mounted workflows', () => {
  it('shows the WebSocket path only for ws/wss and persists custom paths across edits', async () => {
    const runtime = createFakeRuntime(); const wrapper = await mountShell(runtime);
    await wrapper.get('.conn-item__edit').trigger('click');
    expect(wrapper.find('[aria-label="WebSocket 路径"]').exists()).toBe(false);
    await wrapper.get('[aria-label="协议"]').setValue('ws://');
    await wrapper.get('[aria-label="WebSocket 路径"]').setValue('/tenant/mqtt?x=1');
    await wrapper.get('.modal__btn--primary').trigger('click'); await flushPromises();
    expect(runtime.calls.find(call => call[0] === 'connection.save')[1].path).toBe('/tenant/mqtt?x=1');
    await wrapper.get('.conn-item__edit').trigger('click');
    expect(wrapper.get('[aria-label="WebSocket 路径"]').element.value).toBe('/tenant/mqtt?x=1');
    wrapper.unmount();
  });
  it('saving edited configuration preserves status, counters and diagnostics received while saving', async () => {
    const runtime = createFakeRuntime();
    const saved = Promise.withResolvers(); runtime.setSaveConnection(() => saved.promise);
    const wrapper = await mountShell(runtime); await connect(wrapper);
    await wrapper.get('.conn-item__edit').trigger('click');
    await wrapper.get('[aria-label="连接名称"]').setValue('Edited broker');
    await wrapper.get('.modal__btn--primary').trigger('click');
    runtime.emitMessages([{ connId: 'connection-1', topic: 'race', payload: 'during save' }]);
    runtime.emitStatus({ connId: 'connection-1', status: 'disconnected', source: 'broker', code: 'CONNECTION_CLOSED', reason: 'closed during save' });
    await flushPromises();
    const before = wrapper.get('.status-bar').text();
    expect(wrapper.find('.status-bar__btn--disconnect').exists()).toBe(false);
    saved.resolve({ ok: true }); await flushPromises();
    expect(wrapper.find('.status-bar__btn--disconnect').exists()).toBe(false);
    expect(wrapper.get('.status-bar').text()).toBe(before.replace('Connection connection-1', 'Edited broker'));
    expect(wrapper.get('.conn-item__name').text()).toBe('Edited broker');
    expect(runtime.calls.find(call => call[0] === 'connection.save')[1].name).toBe('Edited broker');
    wrapper.unmount();
  });

  it('shows precise clock times with full dates in tooltips and details despite legacy timestamp settings', async () => {
    const runtime = createFakeRuntime({ settings: { timestampFormat: 'absolute', persistReceiveLogs: true } });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    const now = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 6, 9, 14, 38, 12, 45).getTime());
    runtime.emitMessages([{ connId: 'connection-1', topic: 'sensors/time', payload: 'clock test', qos: 0 }]);
    await flushPromises();
    const time = wrapper.get('.chat-msg__time');
    expect(time.text()).toBe('14:38:12.045');
    expect(time.attributes('title')).toBe('2026-07-09 14:38:12.045');
    await wrapper.get('.chat-msg__bubble').trigger('click');
    expect(wrapper.get('.message-inspector').text()).toContain('2026-07-09 14:38:12.045');
    now.mockRestore();
    await runtime.getBeforeCloseHandler()();
    const saved = runtime.calls.filter(call => call[0] === 'history.saveLogs')
      .flatMap(call => call[1]).find(row => row.msg.startsWith('收到: sensors/time'));
    expect(saved.time).toBe('14:38:12.045');
    wrapper.unmount();
  });
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.document.body.innerHTML = '';
  });

  it.each([['端口', '1883.5'], ['Keep Alive (秒)', '60.5'], ['Keep Alive (秒)', '']])(
    'does not save a connection with invalid %s=%j and recovers after correction', async (label, value) => {
      const runtime = createFakeRuntime();
      const wrapper = await mountShell(runtime);
      await wrapper.get('[title="新建连接"]').trigger('click');
      await wrapper.get('input[aria-label="连接名称"]').setValue('Valid name');
      await wrapper.get(`input[aria-label="${label}"]`).setValue(value);
      await findButton(wrapper, '创建连接').trigger('click');
      await flushPromises();
      expect(runtime.calls.filter(call => call[0] === 'connection.save')).toHaveLength(0);
      expect(wrapper.find('.modal__err').exists()).toBe(true);
      await wrapper.get(`input[aria-label="${label}"]`).setValue(label === '端口' ? '1883' : '60');
      await findButton(wrapper, '创建连接').trigger('click');
      await flushPromises();
      expect(runtime.calls.filter(call => call[0] === 'connection.save')).toHaveLength(1);
      wrapper.unmount();
    });

  it('locks every connection field while its captured draft is being saved', async () => {
    const runtime = createFakeRuntime();
    const saved = Promise.withResolvers();
    runtime.setSaveConnection(() => saved.promise);
    const wrapper = await mountShell(runtime);
    await wrapper.get('[title="新建连接"]').trigger('click');
    await wrapper.get('input[aria-label="连接名称"]').setValue('Captured name');
    await findButton(wrapper, '创建连接').trigger('click');
    await flushPromises();
    const controls = wrapper.findAll('.modal input, .modal select');
    expect(controls.every(control => control.element.disabled)).toBe(true);
    saved.resolve({ ok: true });
    await flushPromises();
    expect(wrapper.find('.modal').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the persisted client ID and saves an intentional clear through the connection dialog', async () => {
    const runtime = createFakeRuntime({ connections: [{ ...connection(), client_id: 'old-session' }] });
    const wrapper = await mountShell(runtime);
    await wrapper.get('.conn-item__edit').trigger('click');
    expect(wrapper.get('input[aria-label="Client ID"]').element.value).toBe('old-session');
    await wrapper.get('input[aria-label="Client ID"]').setValue('');
    await findButton(wrapper, '保存').trigger('click');
    await flushPromises();
    expect(runtime.calls.find(call => call[0] === 'connection.save')[1].client_id).toBe('');
    wrapper.unmount();
  });

  it('finishes startup, subscribes runtime events, and registers native close readiness', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountShell(runtime);

    expect(wrapper.find('.workspace-state--loading').exists()).toBe(false);
    expect(wrapper.get('.status-bar__url').text()).toContain('connection-1.example.com');
    expect(runtime.hasMessageHandler()).toBe(true);
    expect(runtime.hasStatusHandler()).toBe(true);
    expect(runtime.getBeforeCloseHandler()).toEqual(expect.any(Function));
    expect(runtime.calls.filter(call => call[0] === 'settings.save')).toHaveLength(0);
    wrapper.unmount();
  });

  it('does not enqueue history already committed by the native runtime', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountShell(runtime);
    runtime.emitMessages([{ connId: 'connection-1', topic: 'native/saved', payload: 'durable', historyPersisted: true }]);
    await flushPromises();
    expect(wrapper.get('.chat-msg__bubble').text()).toContain('durable');
    await runtime.getBeforeCloseHandler()();
    expect(runtime.calls.filter(call => call[0] === 'history.saveMessages')).toHaveLength(0);
    wrapper.unmount();
  });

  it('renders received messages delivered by the runtime callback', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const wrapper = await mountShell(runtime);

    runtime.emitMessages([{
      connId: 'connection-1',
      topic: 'sensors/temperature',
      payload: new Uint8Array([111, 107]),
      qos: 1,
      retained: false,
      timestamp: 1,
    }]);
    await flushPromises();

    expect(wrapper.get('.chat-msg__topic').text()).toBe('sensors/temperature');
    expect(wrapper.get('.chat-msg__bubble').text()).toContain('ok');
    expect(wrapper.text()).toContain('订阅 sensors/#');
    await wrapper.get('[title="复制消息"]').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'clipboard.writeText')).toEqual([
      ['clipboard.writeText', 'ok'],
    ]);
    wrapper.unmount();
  });

  it('copies received HEX bytes using the same format shown in the message bubble', async () => {
    const runtime = createFakeRuntime({
      subscriptions: [subscription('subscription-hex', 'connection-1', 'hex')],
    });
    const wrapper = await mountShell(runtime);

    runtime.emitMessages([{
      connId: 'connection-1',
      topic: 'sensors/raw',
      payload: new Uint8Array([255, 0, 107]),
      qos: 0,
      retained: false,
      timestamp: 1,
    }]);
    await flushPromises();

    expect(wrapper.get('.chat-msg__bubble').text()).toContain('FF 00 6B');
    await wrapper.get('[title="复制消息"]').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'clipboard.writeText')).toEqual([
      ['clipboard.writeText', 'FF 00 6B'],
    ]);
    wrapper.unmount();
  });

  it('copies the full formatted payload when the visible receive preview is truncated', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const wrapper = await mountShell(runtime);
    const fullText = 'a'.repeat((16 * 1024) + 1) + 'z';

    runtime.emitMessages([{
      connId: 'connection-1',
      topic: 'sensors/large',
      payload: Uint8Array.from(fullText, character => character.charCodeAt(0)),
      qos: 0,
      retained: false,
      timestamp: 1,
    }]);
    await flushPromises();

    expect(wrapper.get('.chat-msg__preview-note').text()).toBe('预览已截断，点击消息查看详情');
    expect(wrapper.get('.message-length').text()).toBe(`${fullText.length} B`);
    expect(wrapper.get('.chat-msg__bubble').text()).not.toContain('z');
    await wrapper.get('[title="复制消息"]').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'clipboard.writeText')).toEqual([
      ['clipboard.writeText', fullText],
    ]);
    wrapper.unmount();
  });

  it.each(['all', 'in', 'search'])('keeps sent messages independent from subscriptions and explains hidden sends (%s)', async mode => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    runtime.emitMessages([
      { connId: 'connection-1', topic: 'sensors/temperature', payload: '23' },
      { connId: 'connection-1', topic: 'alerts/device', payload: 'offline' },
    ]);
    await wrapper.get('.sub-item__select').trigger('click');
    await wrapper.get('[aria-label="消息方向"]').setValue(mode === 'in' ? 'in' : 'all');
    if (mode === 'search') await wrapper.get('[aria-label="搜索 Topic（收发均生效）"]').setValue('sensors');
    await wrapper.get('.publish-bar__send').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.chat-msg--in')).toHaveLength(1);
    expect(wrapper.findAll('.chat-msg--out')).toHaveLength(mode === 'all' ? 1 : 0);
    expect(wrapper.find('.publish-bar__notice').exists()).toBe(mode !== 'all');
    if (mode !== 'all') {
      expect(wrapper.get('.publish-bar__notice').text()).toContain('已发送，当前筛选未显示');
      await wrapper.get('.publish-bar__notice button').trigger('click');
      await flushPromises();
      expect(wrapper.get('[aria-label="消息方向"]').element.value).toBe('out');
      expect(wrapper.get('[aria-label="搜索 Topic（收发均生效）"]').element.value).toBe('');
      expect(wrapper.get('.sub-item__select').attributes('aria-pressed')).toBe('true');
      expect(wrapper.findAll('.chat-msg--in')).toHaveLength(0);
      expect(wrapper.findAll('.chat-msg--out')).toHaveLength(1);
      expect(wrapper.find('.publish-bar__notice').exists()).toBe(false);
    }
    expect(runtime.calls.some(call => call[0] === 'publishHistory.save')).toBe(true);
    wrapper.unmount();
  });

  it('contains publish rejection and renders the broker error', async () => {
    const runtime = createFakeRuntime();
    runtime.setPublish(async () => ({ ok: false, error: 'broker denied publish' }));
    const wrapper = await mountShell(runtime);
    await connect(wrapper);

    await wrapper.get('.publish-bar__send').trigger('click');
    await flushPromises();

    expect(wrapper.get('.publish-bar__error').attributes('role')).toBe('alert');
    expect(wrapper.get('.publish-bar__error').text()).toContain('broker denied publish');
    expect(wrapper.find('.publish-bar__notice').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each(['messages', 'logs'])('waits for pending %s to reach storage before opening history', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtime = createFakeRuntime();
    const persisted = Promise.withResolvers();
    if (kind === 'messages') runtime.setSaveMessages(() => persisted.promise);
    else runtime.setSaveLogs(() => persisted.promise);
    const wrapper = await mountShell(runtime);
    try {
      await connect(wrapper);
      if (kind === 'messages') {
        runtime.emitMessages([{ connId: 'connection-1', topic: 'review/history', payload: 'just received' }]);
      } else {
        await findButton(wrapper, '日志').trigger('click');
      }
      await findButton(wrapper, '历史记录').trigger('click');
      await flushPromises();
      expect(runtime.calls.some(call => call[0] === 'window.openHistory')).toBe(false);
      expect(runtime.calls.some(call => call[0] === (kind === 'messages' ? 'history.saveMessages' : 'history.saveLogs'))).toBe(true);
      persisted.resolve({ ok: true });
      await flushPromises();
      expect(runtime.calls.filter(call => call[0] === 'window.openHistory')).toEqual([
        ['window.openHistory', kind, 'connection-1'],
      ]);
    } finally {
      persisted.resolve({ ok: true });
      wrapper.unmount();
    }
  });

  it('contains history window failures and shows an actionable error', async () => {
    const runtime = createFakeRuntime();
    runtime.setOpenHistory(async () => {
      throw new Error('history window unavailable');
    });
    const wrapper = await mountShell(runtime);

    await findButton(wrapper, '历史').trigger('click');
    await flushPromises();

    expect(wrapper.get('.workspace-action-error').attributes('role')).toBe('alert');
    expect(wrapper.get('.workspace-action-error').text()).toContain('history window unavailable');
    wrapper.unmount();
  });

  it('contains settings persistence failures and continues accepting changes', async () => {
    const runtime = createFakeRuntime();
    let attempts = 0;
    runtime.setSaveSetting(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('settings disk unavailable');
    });
    const wrapper = await mountShell(runtime);

    await findButton(wrapper, '设置').trigger('click');
    const toggle = wrapper.findAll('.toggle')[1];
    await toggle.trigger('click');
    await flushPromises();
    expect(attempts).toBe(0);
    await wrapper.get('.settings-dialog').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.settings-error').attributes('role')).toBe('alert');
    expect(wrapper.get('.settings-error').text()).toContain('settings disk unavailable');

    await wrapper.get('.settings-dialog').trigger('submit');
    await flushPromises();
    expect(attempts).toBeGreaterThan(1);
    expect(wrapper.find('.settings-dialog').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps before-close pending through settings, history flushes, and disconnect', async () => {
    const runtime = createFakeRuntime({ settings: { persistReceiveLogs: true } });
    const settingsWrite = Promise.withResolvers();
    const messageWrite = Promise.withResolvers();
    const logWrite = Promise.withResolvers();
    const disconnect = Promise.withResolvers();
    runtime.setSaveSetting(() => settingsWrite.promise);
    runtime.setSaveMessages(() => messageWrite.promise);
    runtime.setSaveLogs(() => logWrite.promise);
    runtime.setDisconnect(() => disconnect.promise);
    const wrapper = await mountShell(runtime);

    await findButton(wrapper, '设置').trigger('click');
    await wrapper.findAll('.toggle')[1].trigger('click');
    await wrapper.get('.settings-dialog').trigger('submit');
    runtime.emitMessages([{
      connId: 'connection-1',
      topic: 'sensors/temperature',
      payload: new Uint8Array([49]),
      qos: 0,
      retained: false,
      timestamp: 1,
    }]);
    await flushPromises();

    const beforeClose = runtime.getBeforeCloseHandler();
    expect(beforeClose).toEqual(expect.any(Function));
    let closed = false;
    const closing = beforeClose().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(false);

    settingsWrite.resolve();
    messageWrite.resolve();
    logWrite.resolve();
    await flushPromises();
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(true);
    expect(closed).toBe(false);

    disconnect.resolve({ ok: true });
    await closing;
    expect(closed).toBe(true);
    wrapper.unmount();
  });

  it('waits for an active publish to persist before flushing and refuses another publish while closing', async () => {
    const runtime = createFakeRuntime();
    const publish = Promise.withResolvers();
    const savePublish = Promise.withResolvers();
    const disconnect = Promise.withResolvers();
    runtime.setPublish(() => publish.promise);
    runtime.setSavePublish(() => savePublish.promise);
    runtime.setDisconnect(() => disconnect.promise);
    const wrapper = await mountShell(runtime);
    await connect(wrapper);

    await wrapper.get('.publish-bar__send').trigger('click');
    await Promise.resolve();
    const closing = runtime.getBeforeCloseHandler()();
    await Promise.resolve();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.publish')).toHaveLength(1);
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(false);

    publish.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'publishHistory.save')).toHaveLength(1);
    expect(runtime.calls.some(call => call[0] === 'history.saveMessages')).toBe(false);
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(false);

    savePublish.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.some(call => call[0] === 'history.saveMessages')).toBe(true);
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(true);

    await wrapper.get('.publish-bar__send').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.publish')).toHaveLength(1);

    disconnect.resolve({ ok: true });
    await closing;
    wrapper.unmount();
  });

  it('waits for the underlying startup load and color repair before disconnecting', async () => {
    const runtime = createFakeRuntime({
      subscriptions: [{ ...subscription(), color: '' }],
    });
    const connectionsLoad = Promise.withResolvers();
    const colorRepair = Promise.withResolvers();
    runtime.setGetConnections(() => connectionsLoad.promise);
    runtime.setAddSubscription(() => colorRepair.promise);
    const wrapper = await mountShell(runtime);

    let closed = false;
    const closing = runtime.getBeforeCloseHandler()().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    connectionsLoad.resolve([connection()]);
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'subscription.add')).toHaveLength(1);
    expect(closed).toBe(false);

    colorRepair.resolve({ ok: true });
    await closing;
    expect(closed).toBe(true);
    wrapper.unmount();
  });

  it('waits for an active connection workflow to finish and flushes its logs before disconnecting', async () => {
    const runtime = createFakeRuntime();
    const connected = Promise.withResolvers();
    runtime.setConnect(() => connected.promise);
    const wrapper = await mountShell(runtime);

    await wrapper.get('.status-bar__btn').trigger('click');
    await Promise.resolve();
    const closing = runtime.getBeforeCloseHandler()();
    await flushPromises();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.connect')).toHaveLength(1);
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(false);

    connected.resolve({ ok: true });
    await closing;
    const logFlushIndex = runtime.calls.findIndex(call => call[0] === 'history.saveLogs');
    const disconnectIndex = runtime.calls.findIndex(call => call[0] === 'mqtt.disconnect');
    expect(logFlushIndex).toBeGreaterThan(-1);
    expect(disconnectIndex).toBeGreaterThan(logFlushIndex);
    wrapper.unmount();
  });

  it('disables and refuses connect after closing begins', async () => {
    const runtime = createFakeRuntime();
    const disconnected = Promise.withResolvers();
    runtime.setDisconnect(() => disconnected.promise);
    const wrapper = await mountShell(runtime);

    const closing = runtime.getBeforeCloseHandler()();
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.status-bar__btn').attributes('disabled')).toBeDefined();

    await wrapper.get('.status-bar__btn').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.connect')).toHaveLength(0);

    disconnected.resolve({ ok: true });
    await closing;
    wrapper.unmount();
  });

  it('contains subscription restore rejection from the runtime status callback', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setSubscribe(async () => {
      throw new Error('restore broker unavailable');
    });
    const wrapper = await mountShell(runtime);

    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    await findButton(wrapper, '日志').trigger('click');

    expect(wrapper.get('.log-view').text()).toContain('restore broker unavailable');
    wrapper.unmount();
  });

  it('waits for history clearing before shutdown flush and disconnect', async () => {
    const runtime = createFakeRuntime();
    const cleared = Promise.withResolvers();
    runtime.setClearHistoryStorage(() => cleared.promise);
    vi.spyOn(globalThis.window, 'confirm').mockReturnValue(true);
    const wrapper = await mountShell(runtime);

    await findButton(wrapper, '设置').trigger('click');
    await flushPromises();
    await findButton(wrapper, '清空历史数据').trigger('click');
    await flushPromises();
    const closing = runtime.getBeforeCloseHandler()();
    await Promise.resolve();

    expect(runtime.calls.filter(call => call[0] === 'storage.clearHistory')).toHaveLength(1);
    expect(runtime.calls.some(call => call[0] === 'mqtt.disconnect')).toBe(false);

    cleared.resolve({ total_count: 0 });
    await closing;
    const clearIndex = runtime.calls.findIndex(call => call[0] === 'storage.clearHistory');
    const disconnectIndex = runtime.calls.findIndex(call => call[0] === 'mqtt.disconnect');
    expect(disconnectIndex).toBeGreaterThan(clearIndex);
    wrapper.unmount();
  });

  it('bounds shutdown when publish never settles and ignores its late success', async () => {
    vi.useFakeTimers();
    const runtime = createFakeRuntime();
    const publish = Promise.withResolvers();
    runtime.setPublish(() => publish.promise);
    const wrapper = await mountShell(runtime);
    await connect(wrapper);

    await wrapper.get('.publish-bar__send').trigger('click');
    await Promise.resolve();
    let closed = false;
    const closing = runtime.getBeforeCloseHandler()().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(closed).toBe(true);

    const publishHistoryCalls = runtime.calls.filter(call => call[0] === 'publishHistory.save').length;
    const messageFlushCalls = runtime.calls.filter(call => call[0] === 'history.saveMessages').length;
    publish.resolve({ ok: true });
    await flushPromises();
    await vi.runOnlyPendingTimersAsync();
    expect(runtime.calls.filter(call => call[0] === 'publishHistory.save')).toHaveLength(publishHistoryCalls);
    expect(runtime.calls.filter(call => call[0] === 'history.saveMessages')).toHaveLength(messageFlushCalls);

    await closing;
    wrapper.unmount();
  });

  it('bounds shutdown when startup load never settles and contains its late rejection', async () => {
    vi.useFakeTimers();
    const runtime = createFakeRuntime();
    const connectionsLoad = Promise.withResolvers();
    runtime.setGetConnections(() => connectionsLoad.promise);
    const wrapper = await mountShell(runtime);

    let closed = false;
    const closing = runtime.getBeforeCloseHandler()().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(closed).toBe(true);

    connectionsLoad.reject(new Error('late load rejection'));
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'subscription.add')).toHaveLength(0);

    await closing;
    wrapper.unmount();
  });

  it('awaits broker unsubscribe before deleting persistence and local state', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const broker = Promise.withResolvers();
    runtime.setUnsubscribe(() => broker.promise);
    const wrapper = await mountShell(runtime);
    await connect(wrapper);

    await wrapper.get('.sub-item__more').trigger('click');
    await wrapper.get('.sub-item__del').trigger('click');
    await findButton(wrapper, '确认取消').trigger('click');
    await flushPromises();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.unsubscribe')).toEqual([
      ['mqtt.unsubscribe', 'connection-1', 'sensors/#'],
    ]);
    expect(runtime.calls.some(call => call[0] === 'subscription.remove')).toBe(false);
    expect(wrapper.find('.sub-item').exists()).toBe(true);

    broker.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.some(call => call[0] === 'subscription.remove')).toBe(true);
    expect(wrapper.find('.sub-item').exists()).toBe(false);
    wrapper.unmount();
  });

  async function removeFirstSubscription(wrapper) {
    await wrapper.findAll('.sub-item__more')[0].trigger('click');
    await wrapper.get('.sub-item__del').trigger('click');
    await findButton(wrapper, '确认取消').trigger('click');
    await flushPromises();
  }

  const broadAndNarrow = () => [
    { ...subscription('broad'), topic: 'review/#', qos: 0 },
    { ...subscription('narrow'), topic: 'review/value', qos: 2 },
  ];
  const pendingKey = 'mqtt.pendingUnsubscriptions.connection-1';

  it('registers every saved filter with its own QoS on connect and reconnect', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
      ['mqtt.subscribe', 'connection-1', 'review/value', 2],
    ]);
    runtime.calls.length = 0;
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
      ['mqtt.subscribe', 'connection-1', 'review/value', 2],
    ]);
    wrapper.unmount();
  });

  it('registers a new covered filter at its requested QoS', async () => {
    const runtime = createFakeRuntime({ subscriptions: [broadAndNarrow()[0]] });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    runtime.calls.length = 0;
    await wrapper.get('[title="添加订阅"]').trigger('click');
    await wrapper.get('[placeholder="例如：device/sensor/#"]').setValue('review/value');
    await wrapper.get('[aria-label="订阅 QoS"]').setValue('0');
    await findButton(wrapper, '确认订阅').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/value', 0],
    ]);
    expect(wrapper.findAll('.sub-item')).toHaveLength(2);
    wrapper.unmount();
  });

  it('ensures a retained legacy covered filter works before removing the broad filter', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    const wrapper = await mountShell(runtime);
    // Legacy sessions may never have registered the narrow filter at the broker.
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.filter(call => call[0].startsWith('mqtt.'))).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/value', 2],
      ['mqtt.unsubscribe', 'connection-1', 'review/#'],
    ]);
    expect(wrapper.findAll('.sub-item')).toHaveLength(1);
    expect(wrapper.get('.sub-item__topic').text()).toBe('review/value');
    wrapper.unmount();
  });

  it('keeps the broad filter when replacement registration fails', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    runtime.setSubscribe(async () => ({ ok: false, error: 'replacement refused' }));
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.some(call => call[0] === 'mqtt.unsubscribe')).toBe(false);
    expect(runtime.calls.some(call => call[0] === 'subscription.remove')).toBe(false);
    expect(wrapper.findAll('.sub-item')).toHaveLength(2);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('replacement refused');
    wrapper.unmount();
  });

  it('restores the removed broker filter if local deletion fails', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setRemoveSubscription(async () => ({ ok: false, error: 'delete disk unavailable' }));
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.filter(call => call[0].startsWith('mqtt.'))).toEqual([
      ['mqtt.unsubscribe', 'connection-1', 'sensors/#'],
      ['mqtt.subscribe', 'connection-1', 'sensors/#', 1],
    ]);
    expect(wrapper.find('.sub-item').exists()).toBe(true);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('delete disk unavailable');
    wrapper.unmount();
  });

  it('removes offline configuration after persisting broker cleanup and replays it before restoration', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    runtime.setUnsubscribe(async () => ({ ok: false, error: 'not connected' }));
    const wrapper = await mountShell(runtime);
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.some(call => call[0] === 'mqtt.unsubscribe')).toBe(false);
    expect(runtime.calls.find(call => call[0] === 'settings.save')).toEqual([
      'settings.save', pendingKey, JSON.stringify(['review/#']),
    ]);
    expect(wrapper.findAll('.sub-item')).toHaveLength(1);
    runtime.setUnsubscribe(async () => ({ ok: true }));
    runtime.calls.length = 0;
    await connect(wrapper);
    expect(runtime.calls.filter(call => call[0].startsWith('mqtt.')).map(call => call.slice(0, 3))).toEqual([
      ['mqtt.connect', expect.any(Object)],
      ['mqtt.unsubscribe', 'connection-1', 'review/#'],
      ['mqtt.subscribe', 'connection-1', 'review/value'],
    ]);
    expect(runtime.calls).toContainEqual(['settings.save', pendingKey, '[]']);
    wrapper.unmount();
  });

  it('keeps offline configuration when durable cleanup cannot be saved', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setSaveSetting(async () => ({ ok: false, error: 'queue disk unavailable' }));
    const wrapper = await mountShell(runtime);
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.some(call => call[0] === 'subscription.remove')).toBe(false);
    expect(wrapper.find('.sub-item').exists()).toBe(true);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('queue disk unavailable');
    wrapper.unmount();
  });

  it('replays persisted cleanup after restart and retries failed ACK without losing retained filters', async () => {
    const runtime = createFakeRuntime({
      subscriptions: [broadAndNarrow()[1]],
      settings: { [pendingKey]: JSON.stringify(['review/#']) },
    });
    runtime.setUnsubscribe(async () => ({ ok: false, error: 'cleanup refused' }));
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    expect(runtime.calls).toContainEqual(['mqtt.unsubscribe', 'connection-1', 'review/#']);
    expect(runtime.calls).toContainEqual(['mqtt.subscribe', 'connection-1', 'review/value', 2]);
    expect(runtime.calls).not.toContainEqual(['settings.save', pendingKey, '[]']);
    await findButton(wrapper, '日志').trigger('click');
    expect(wrapper.get('.log-view').text()).toContain('cleanup refused');
    runtime.setUnsubscribe(async () => ({ ok: true }));
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.unsubscribe')).toHaveLength(2);
    expect(runtime.calls).toContainEqual(['settings.save', pendingKey, '[]']);
    wrapper.unmount();
  });

  it('does not unsubscribe a retained filter after an interrupted offline deletion', async () => {
    const runtime = createFakeRuntime({
      subscriptions: [subscription()],
      settings: { [pendingKey]: JSON.stringify(['sensors/#']) },
    });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    expect(runtime.calls.some(call => call[0] === 'mqtt.unsubscribe')).toBe(false);
    expect(runtime.calls).toContainEqual(['mqtt.subscribe', 'connection-1', 'sensors/#', 1]);
    expect(runtime.calls).toContainEqual(['settings.save', pendingKey, '[]']);
    wrapper.unmount();
  });

  it('waits for offline deletion to settle before a reconnect cleans the persistent session', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const removed = Promise.withResolvers();
    runtime.setRemoveSubscription(() => removed.promise);
    const wrapper = await mountShell(runtime);
    await removeFirstSubscription(wrapper);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    expect(runtime.calls.some(call => call[0] === 'mqtt.unsubscribe')).toBe(false);
    removed.resolve({ ok: true });
    await flushPromises();
    expect(wrapper.find('.sub-item').exists()).toBe(false);
    expect(runtime.calls).toContainEqual(['mqtt.unsubscribe', 'connection-1', 'sensors/#']);
    expect(runtime.calls.some(call => call[0] === 'mqtt.subscribe')).toBe(false);
    wrapper.unmount();
  });

  it('keeps saved subscriptions when broker unsubscribe is refused', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setUnsubscribe(async () => ({ ok: false, error: 'unsubscribe refused' }));
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.some(call => call[0] === 'subscription.remove')).toBe(false);
    expect(wrapper.find('.sub-item').exists()).toBe(true);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('unsubscribe refused');
    wrapper.unmount();
  });

  it('reports failed compensation and marks the retained original subscription failed', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setRemoveSubscription(async () => { throw new Error('delete disk unavailable'); });
    runtime.setSubscribe(async () => ({ ok: false, error: 'restore refused' }));
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('delete disk unavailable');
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('restore refused');
    expect(wrapper.get('.sub-item__dot').attributes('aria-label')).toBe('订阅失败');
    wrapper.unmount();
  });

  it('protects offline configuration after failed deletion on the next reconnect', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setRemoveSubscription(async () => ({ ok: false, error: 'delete disk unavailable' }));
    const wrapper = await mountShell(runtime);
    await removeFirstSubscription(wrapper);
    expect(wrapper.find('.sub-item').exists()).toBe(true);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('delete disk unavailable');
    await connect(wrapper);
    expect(runtime.calls.some(call => call[0] === 'mqtt.unsubscribe')).toBe(false);
    expect(runtime.calls).toContainEqual(['mqtt.subscribe', 'connection-1', 'sensors/#', 1]);
    expect(runtime.calls).toContainEqual(['settings.save', pendingKey, '[]']);
    wrapper.unmount();
  });

  it('retries acknowledged cleanup when clearing the durable queue fails', async () => {
    const runtime = createFakeRuntime({
      subscriptions: [broadAndNarrow()[1]],
      settings: { [pendingKey]: JSON.stringify(['review/#']) },
    });
    runtime.setSaveSetting(async () => ({ ok: false, error: 'cleanup disk unavailable' }));
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    expect(runtime.calls).toContainEqual(['mqtt.subscribe', 'connection-1', 'review/value', 2]);
    await findButton(wrapper, '日志').trigger('click');
    expect(wrapper.get('.log-view').text()).toContain('cleanup disk unavailable');
    runtime.setSaveSetting(async () => ({ ok: true }));
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.unsubscribe')).toHaveLength(2);
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toHaveLength(2);
    wrapper.unmount();
  });

  it('reconciles only filters affected by the removal on that connection', async () => {
    const runtime = createFakeRuntime({
      connections: [connection(), connection('connection-2')],
      subscriptions: [
        ...broadAndNarrow(),
        { ...subscription('unrelated'), topic: 'private/#' },
        { ...subscription('other', 'connection-2'), topic: 'review/other' },
      ],
    });
    runtime.setSubscribe(async (_id, topic) => topic === 'private/#'
      ? { ok: false, error: 'unrelated filter denied' } : { ok: true });
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/value', 2],
    ]);
    expect(wrapper.findAll('.sub-item')).toHaveLength(2);
    wrapper.unmount();
  });

  it('waits for replacement ACK before removing the broad broker filter', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    const replacement = Promise.withResolvers();
    runtime.setSubscribe(() => replacement.promise);
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected' });
    await removeFirstSubscription(wrapper);
    expect(runtime.calls.some(call => call[0] === 'mqtt.unsubscribe')).toBe(false);
    expect(runtime.calls.some(call => call[0] === 'subscription.remove')).toBe(false);
    replacement.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls).toContainEqual(['mqtt.unsubscribe', 'connection-1', 'review/#']);
    expect(wrapper.findAll('.sub-item')).toHaveLength(1);
    wrapper.unmount();
  });

  it('waits for persistent cleanup before adding a filter with the same topic', async () => {
    const runtime = createFakeRuntime({ settings: { [pendingKey]: JSON.stringify(['review/value']) } });
    const cleanup = Promise.withResolvers();
    runtime.setUnsubscribe(() => cleanup.promise);
    const wrapper = await mountShell(runtime);
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    await wrapper.get('[title="添加订阅"]').trigger('click');
    await wrapper.get('[placeholder="例如：device/sensor/#"]').setValue('review/value');
    await wrapper.get('[aria-label="订阅 QoS"]').setValue('0');
    await findButton(wrapper, '确认订阅').trigger('click');
    await flushPromises();
    expect(runtime.calls.some(call => call[0] === 'mqtt.subscribe')).toBe(false);
    cleanup.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls).toContainEqual(['mqtt.subscribe', 'connection-1', 'review/value', 0]);
    expect(wrapper.findAll('.sub-item')).toHaveLength(1);
    wrapper.unmount();
  });

  it('stops subscription restoration after disconnect invalidates a pending ACK', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    const pending = Promise.withResolvers();
    runtime.setSubscribe(() => pending.promise);
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    await wrapper.get('.status-bar__btn--disconnect').trigger('click');
    await flushPromises();
    pending.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
    ]);
    expect(wrapper.findAll('.sub-item__dot').every(dot => dot.attributes('aria-label') === '未订阅')).toBe(true);
    wrapper.unmount();
  });

  it.each([{ ok: true }, { ok: false, error: 'old disconnect failed' }])(
    'ignores a stale disconnect completion after a fresh connection: %j', async (result) => {
      const runtime = createFakeRuntime({ subscriptions: [subscription()] });
      const oldDisconnect = Promise.withResolvers();
      runtime.setDisconnect(() => oldDisconnect.promise);
      const wrapper = await mountShell(runtime);
      await connect(wrapper);
      await wrapper.get('.status-bar__btn--disconnect').trigger('click');
      // Native disconnect announces the stopped socket before awaiting end().
      runtime.emitStatus({ connId: 'connection-1', status: 'disconnected' });
      await flushPromises();
      await connect(wrapper);
      oldDisconnect.resolve(result);
      await flushPromises();
      expect(wrapper.find('.status-bar__btn--disconnect').exists()).toBe(true);
      expect(wrapper.findAll('.sub-item__dot').every(dot => dot.attributes('aria-label') === '已订阅')).toBe(true);
      expect(wrapper.text()).not.toContain('old disconnect failed');
      wrapper.unmount();
    });

  it('queues new manual connection restoration while the previous connection ACK is pending', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    const oldAck = Promise.withResolvers();
    let first = true;
    runtime.setSubscribe(async () => {
      if (first) { first = false; return oldAck.promise; }
      return { ok: true };
    });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    await wrapper.get('.status-bar__btn--disconnect').trigger('click');
    await flushPromises();
    await connect(wrapper);
    oldAck.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
      ['mqtt.subscribe', 'connection-1', 'review/value', 2],
    ]);
    expect(wrapper.findAll('.sub-item__dot').every(dot => dot.attributes('aria-label') === '已订阅')).toBe(true);
    wrapper.unmount();
  });

  it('replays cleanup on the new connection when an old unsubscribe ACK was delayed', async () => {
    const runtime = createFakeRuntime({
      subscriptions: broadAndNarrow(),
      settings: { [pendingKey]: JSON.stringify(['obsolete/#']) },
    });
    const oldAck = Promise.withResolvers();
    let first = true;
    runtime.setUnsubscribe(async () => {
      if (first) { first = false; return oldAck.promise; }
      return { ok: true };
    });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    await wrapper.get('.status-bar__btn--disconnect').trigger('click');
    await flushPromises();
    await connect(wrapper);
    oldAck.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.unsubscribe')).toEqual([
      ['mqtt.unsubscribe', 'connection-1', 'obsolete/#'],
      ['mqtt.unsubscribe', 'connection-1', 'obsolete/#'],
    ]);
    expect(runtime.calls).toContainEqual(['settings.save', pendingKey, '[]']);
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toHaveLength(2);
    expect(wrapper.findAll('.sub-item__dot').every(dot => dot.attributes('aria-label') === '已订阅')).toBe(true);
    wrapper.unmount();
  });

  it('coalesces duplicate automatic reconnect events for the new connection generation', async () => {
    const runtime = createFakeRuntime({ subscriptions: broadAndNarrow() });
    const oldAck = Promise.withResolvers();
    const newAck = Promise.withResolvers();
    let attempts = 0;
    runtime.setSubscribe(async () => {
      attempts += 1;
      if (attempts === 1) return oldAck.promise;
      if (attempts === 2) return newAck.promise;
      return { ok: true };
    });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    runtime.emitStatus({ connId: 'connection-1', status: 'reconnecting' });
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    runtime.emitStatus({ connId: 'connection-1', status: 'connected', reconnected: true });
    await flushPromises();
    oldAck.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toHaveLength(2);
    expect(wrapper.findAll('.sub-item__dot').some(dot => dot.attributes('aria-label') === '已订阅')).toBe(false);
    newAck.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
      ['mqtt.subscribe', 'connection-1', 'review/#', 0],
      ['mqtt.subscribe', 'connection-1', 'review/value', 2],
    ]);
    expect(wrapper.findAll('.sub-item__dot').every(dot => dot.attributes('aria-label') === '已订阅')).toBe(true);
    wrapper.unmount();
  });

  it('awaits disconnect before deleting the active connection and its subscriptions', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const disconnected = Promise.withResolvers();
    runtime.setDisconnect(() => disconnected.promise);
    const wrapper = await mountShell(runtime);
    await connect(wrapper);

    await wrapper.get('.conn-item__del').trigger('click');
    await findButton(wrapper, '确认删除').trigger('click');
    await Promise.resolve();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.disconnect')).toHaveLength(1);
    expect(runtime.calls.some(call => call[0] === 'connection.delete')).toBe(false);
    expect(wrapper.find('.conn-item').exists()).toBe(true);
    expect(wrapper.find('.sub-item').exists()).toBe(true);

    disconnected.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.some(call => call[0] === 'connection.delete')).toBe(true);
    expect(wrapper.find('.conn-item').exists()).toBe(false);
    expect(wrapper.find('.sub-item').exists()).toBe(false);
    wrapper.unmount();
  });

  it('preserves connection state when disconnect resolves with a failure result', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    runtime.setDisconnect(async () => ({ ok: false, error: 'broker refused disconnect' }));
    const wrapper = await mountShell(runtime);
    await connect(wrapper);

    await wrapper.get('.conn-item__del').trigger('click');
    await findButton(wrapper, '确认删除').trigger('click');
    await flushPromises();

    expect(runtime.calls.some(call => call[0] === 'connection.delete')).toBe(false);
    expect(wrapper.find('.conn-item').exists()).toBe(true);
    expect(wrapper.find('.sub-item').exists()).toBe(true);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('broker refused disconnect');
    wrapper.unmount();
  });

  it('does not expose a cloned connection until persistence succeeds and reports failure', async () => {
    const runtime = createFakeRuntime();
    const saved = Promise.withResolvers();
    runtime.setSaveConnection(() => saved.promise);
    const wrapper = await mountShell(runtime);

    await wrapper.get('.conn-item__clone').trigger('click');
    await Promise.resolve();
    expect(wrapper.findAll('.conn-item')).toHaveLength(1);
    expect(wrapper.get('.conn-item__clone').attributes('disabled')).toBeDefined();

    saved.resolve({ ok: false, error: 'clone persistence denied' });
    await flushPromises();
    expect(wrapper.findAll('.conn-item')).toHaveLength(1);
    expect(wrapper.get('.workspace-action-error').text()).toContain('clone persistence denied');
    wrapper.unmount();
  });

  it('keeps a new connection draft open and local state unchanged when persistence fails', async () => {
    const runtime = createFakeRuntime();
    runtime.setSaveConnection(async () => ({ ok: false, error: 'create persistence denied' }));
    const wrapper = await mountShell(runtime);

    await wrapper.get('[title="新建连接"]').trigger('click');
    await wrapper.get('[placeholder="例如：本地开发 Broker"]').setValue('New broker');
    await findButton(wrapper, '创建连接').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.conn-item')).toHaveLength(1);
    expect(wrapper.get('[placeholder="例如：本地开发 Broker"]').element.value).toBe('New broker');
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('create persistence denied');
    wrapper.unmount();
  });

  it('keeps the original connection values when editing persistence fails', async () => {
    const runtime = createFakeRuntime();
    runtime.setSaveConnection(async () => ({ ok: false, error: 'edit persistence denied' }));
    const wrapper = await mountShell(runtime);

    await wrapper.get('.conn-item__edit').trigger('click');
    await wrapper.get('[placeholder="例如：本地开发 Broker"]').setValue('Edited name');
    await findButton(wrapper, '保存').trigger('click');
    await flushPromises();

    expect(wrapper.get('.conn-item__name').text()).toBe('Connection connection-1');
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('edit persistence denied');
    wrapper.unmount();
  });

  it('awaits broker subscribe and rolls it back when new-subscription persistence fails', async () => {
    const runtime = createFakeRuntime();
    const broker = Promise.withResolvers();
    const persisted = Promise.withResolvers();
    runtime.setSubscribe(() => broker.promise);
    runtime.setAddSubscription(() => persisted.promise);
    runtime.setUnsubscribe(async () => ({ ok: false, error: 'subscription rollback denied' }));
    const wrapper = await mountShell(runtime);

    await wrapper.get('[title="添加订阅"]').trigger('click');
    await wrapper.get('[placeholder="例如：device/sensor/#"]').setValue('devices/+/status');
    await wrapper.get('[aria-label="订阅 QoS"]').setValue('0');
    await findButton(wrapper, '确认订阅').trigger('click');
    await Promise.resolve();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-1', 'devices/+/status', 0],
    ]);
    expect(runtime.calls.some(call => call[0] === 'subscription.add')).toBe(false);
    expect(wrapper.find('.sub-item').exists()).toBe(false);
    expect(findButton(wrapper, '订阅中')).toBeTruthy();

    broker.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'subscription.add')).toHaveLength(1);
    expect(wrapper.find('.sub-item').exists()).toBe(false);

    persisted.reject(new Error('subscription disk unavailable'));
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'mqtt.unsubscribe')).toEqual([
      ['mqtt.unsubscribe', 'connection-1', 'devices/+/status'],
    ]);
    expect(wrapper.find('.sub-item').exists()).toBe(false);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('subscription disk unavailable');
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('subscription rollback denied');
    wrapper.unmount();
  });

  it('subscribes a connected copy target before persistence and local activation', async () => {
    const runtime = createFakeRuntime({
      connections: [connection('connection-1'), connection('connection-2')],
      subscriptions: [subscription()],
    });
    const broker = Promise.withResolvers();
    const persisted = Promise.withResolvers();
    runtime.setSubscribe(() => broker.promise);
    runtime.setAddSubscription(() => persisted.promise);
    const wrapper = await mountShell(runtime);

    await wrapper.findAll('.conn-item')[1].trigger('click');
    await connect(wrapper);
    await wrapper.findAll('.conn-item')[0].trigger('click');
    await wrapper.get('.sub-item__more').trigger('click');
    await wrapper.get('[title="复制订阅到连接"]').trigger('click');
    await wrapper.get('.modal__btn--primary').trigger('click');
    await Promise.resolve();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.subscribe')).toEqual([
      ['mqtt.subscribe', 'connection-2', 'sensors/#', 1],
    ]);
    expect(runtime.calls.some(call => call[0] === 'subscription.add')).toBe(false);
    expect(wrapper.get('.modal').text()).toContain('复制订阅');

    broker.resolve({ ok: true });
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'subscription.add')).toHaveLength(1);
    expect(wrapper.get('.modal').text()).toContain('复制订阅');

    persisted.resolve({ ok: true });
    await flushPromises();
    expect(wrapper.find('.modal').exists()).toBe(false);
    await wrapper.findAll('.conn-item')[1].trigger('click');
    expect(wrapper.get('.sub-item__topic').text()).toBe('sensors/#');
    wrapper.unmount();
  });

  it('rolls back a connected copy target and keeps the dialog open when persistence fails', async () => {
    const runtime = createFakeRuntime({
      connections: [connection('connection-1'), connection('connection-2')],
      subscriptions: [subscription()],
    });
    runtime.setSubscribe(async () => ({ ok: true }));
    runtime.setUnsubscribe(async () => ({ ok: false, error: 'copy rollback denied' }));
    runtime.setAddSubscription(async () => {
      throw new Error('copy persistence unavailable');
    });
    const wrapper = await mountShell(runtime);

    await wrapper.findAll('.conn-item')[1].trigger('click');
    await connect(wrapper);
    await wrapper.findAll('.conn-item')[0].trigger('click');
    await wrapper.get('.sub-item__more').trigger('click');
    await wrapper.get('[title="复制订阅到连接"]').trigger('click');
    await wrapper.get('.modal__btn--primary').trigger('click');
    await flushPromises();

    expect(runtime.calls.filter(call => call[0] === 'mqtt.unsubscribe')).toEqual([
      ['mqtt.unsubscribe', 'connection-2', 'sensors/#'],
    ]);
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('copy persistence unavailable');
    expect(wrapper.get('.modal [role="alert"]').text()).toContain('copy rollback denied');
    await wrapper.findAll('.conn-item')[1].trigger('click');
    expect(wrapper.find('.sub-item').exists()).toBe(false);
    wrapper.unmount();
  });

  it('uses the runtime update channel and opens only the validated download URL', async () => {
    const runtime = createFakeRuntime();
    runtime.setCheckUpdate(async () => ({
      available: true,
      version: '0.2.0',
      url: 'https://downloads.example.com/mqtt-tool.zip',
      force: false,
      description: 'Quality fixes',
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const wrapper = await mountShell(runtime);

    await findButton(wrapper, '关于').trigger('click');
    await findButton(wrapper, '检查更新').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'update.check')).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('发现新版本 0.2.0');
    expect(wrapper.text()).toContain('Quality fixes');

    await wrapper.get('.update-download').trigger('click');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'window.openExternal')).toEqual([
      ['window.openExternal', 'https://downloads.example.com/mqtt-tool.zip'],
    ]);
    wrapper.unmount();
  });

  it('downloads natively, preserves state across About reopening, and cancels through the adapter', async () => {
    const runtime = createFakeRuntime();
    let updateListener;
    runtime.adapter.update.onState = handler => { updateListener = handler; return () => {}; };
    runtime.adapter.update.getState = async () => ({ phase: 'available', supported: true });
    runtime.setCheckUpdate(async () => ({ available: true, automatic: true, version: '0.1.1' }));
    const download = vi.fn(async () => updateListener({ phase: 'downloading', supported: true, transferred: 16, total: 32, canCancel: true }));
    const cancel = vi.fn(async () => updateListener({ phase: 'available', supported: true }));
    runtime.adapter.update.download = download;
    runtime.adapter.update.cancel = cancel;
    const wrapper = await mountShell(runtime);
    await findButton(wrapper, '关于').trigger('click');
    await findButton(wrapper, '检查更新').trigger('click');
    await flushPromises();
    await wrapper.get('.update-download').trigger('click');
    await flushPromises();
    expect(download).toHaveBeenCalledOnce();
    expect(runtime.calls.some(call => call[0] === 'window.openExternal')).toBe(false);
    wrapper.findComponent(UpdateProgress).vm.$emit('cancel');
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    updateListener({ phase: 'ready', supported: true });
    await wrapper.get('.about-panel__close').trigger('click');
    await findButton(wrapper, '关于').trigger('click');
    expect(wrapper.findComponent(UpdateProgress).props('state').phase).toBe('ready');
    wrapper.unmount();
  });

  it.each([false, true])('update installation handshake saves the last delivered message and recovers on failure=%s', async failSave => {
    const runtime = createFakeRuntime();
    let updateListener;
    runtime.adapter.update.onState = handler => { updateListener = handler; return () => {}; };
    runtime.adapter.update.getState = async () => ({ phase: 'ready', supported: true });
    const installed = vi.fn();
    runtime.setDisconnect(async () => {
      runtime.emitMessages([{ connId: 'connection-1', topic: 'last/message', payload: 'durable', qos: 1 }]);
      return { ok: true };
    });
    if (failSave) runtime.setSaveMessages(async () => { throw new Error('disk unavailable'); });
    runtime.adapter.update.install = async () => {
      updateListener({ phase: 'preparing', supported: true });
      try {
        await runtime.getBeforeCloseHandler()({ requestId: 'test-update', purpose: 'update' });
        installed();
        updateListener({ phase: 'installing', supported: true });
      } catch (error) {
        updateListener({ phase: 'ready', supported: true, error: error.message });
        throw error;
      }
    };
    const wrapper = await mountShell(runtime);
    await findButton(wrapper, '关于').trigger('click');
    wrapper.findComponent(UpdateProgress).vm.$emit('install');
    await flushPromises();
    expect(runtime.calls.filter(call => call[0] === 'history.saveMessages').flatMap(call => call[1]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ topic: 'last/message', payload: 'durable' })]));
    expect(installed).toHaveBeenCalledTimes(failSave ? 0 : 1);
    if (failSave) {
      await vi.waitFor(() => expect(wrapper.findComponent(UpdateProgress).props('state').error).toContain('disk unavailable'), { timeout: 2000 });
      expect(wrapper.findComponent(UpdateProgress).props('state').error).toContain('disk unavailable');
      await wrapper.get('.about-panel__close').trigger('click');
      await wrapper.get('.status-bar__btn').trigger('click');
      await flushPromises();
      expect(runtime.calls.some(call => call[0] === 'mqtt.connect')).toBe(true);
    }
    expect(runtime.hasMessageHandler()).toBe(true);
    wrapper.unmount();
  });

  it('leaves update checking state and exposes the error when the runtime rejects', async () => {
    const runtime = createFakeRuntime();
    runtime.setCheckUpdate(async () => { throw new Error('update service unavailable'); });
    const wrapper = await mountShell(runtime);

    await findButton(wrapper, '关于').trigger('click');
    await findButton(wrapper, '检查更新').trigger('click');
    await flushPromises();

    expect(findButton(wrapper, '检查更新').attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).toContain('检测失败: update service unavailable');
    wrapper.unmount();
  });

  it('adds keyboard row semantics, switch semantics, and focused labelled dialogs', async () => {
    const runtime = createFakeRuntime({ subscriptions: [subscription()] });
    const wrapper = await mountShell(runtime, { attachTo: true });

    expect(wrapper.get('.conn-item__select').element.tagName).toBe('BUTTON');
    expect(wrapper.get('.conn-item__select').attributes('aria-label')).toContain('选择连接');
    expect(wrapper.get('.conn-item__select').find('button').exists()).toBe(false);
    expect(wrapper.get('.sub-item__select').element.tagName).toBe('BUTTON');
    expect(wrapper.get('.sub-item__select').attributes('aria-label')).toContain('筛选订阅');

    await findButton(wrapper, '设置').trigger('click');
    const toggle = wrapper.get('button.toggle');
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.attributes('aria-checked')).toMatch(/true|false/);
    await wrapper.get('[aria-label="关闭设置"]').trigger('click');

    await wrapper.get('[title="新建连接"]').trigger('click');
    const dialog = wrapper.get('.modal');
    expect(dialog.attributes('role')).toBe('dialog');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')).toBeTruthy();
    expect(wrapper.get('.modal__close').attributes('aria-label')).toBeTruthy();
    await flushPromises();
    expect(globalThis.globalThis.document.activeElement).toBe(wrapper.get('[placeholder="例如：本地开发 Broker"]').element);
    wrapper.unmount();
  });
  it('keeps settings drafts out of persistence until Save and offers discard on Escape', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountShell(runtime, { attachTo: true });
    const trigger = findButton(wrapper, '设置');
    trigger.element.focus();
    await trigger.trigger('click');
    await wrapper.get('[aria-label="实时消息条目"]').setValue(700);
    expect(runtime.calls.filter(call => call[0] === 'settings.save')).toHaveLength(0);
    await wrapper.get('.settings-dialog').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.settings-discard').exists()).toBe(true);
    await findButton(wrapper, '放弃修改').trigger('click');
    expect(wrapper.find('.settings-dialog').exists()).toBe(false);
    expect(globalThis.document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    expect(wrapper.get('[aria-label="实时消息条目"]').element.value).toBe('300');
    wrapper.unmount();
  });

  it('traps Tab in connection dialogs and returns focus after Escape', async () => {
    const wrapper = await mountShell(createFakeRuntime(), { attachTo: true });
    const trigger = wrapper.get('[title="新建连接"]');
    trigger.element.focus();
    await trigger.trigger('click');
    await flushPromises();
    const controls = wrapper.get('.modal').findAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
    controls.at(-1).element.focus();
    await controls.at(-1).trigger('keydown', { key: 'Tab' });
    expect(globalThis.document.activeElement).toBe(controls[0].element);
    await controls[0].trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(globalThis.document.activeElement).toBe(controls.at(-1).element);
    await wrapper.get('.modal').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.modal').exists()).toBe(false);
    expect(globalThis.document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('uses the saved clean session default only for new connections', async () => {
    const runtime = createFakeRuntime({
      connections: [{ ...connection(), clean_session: 1 }],
      settings: { cleanSession: false, keepalive: 120 },
    });
    const wrapper = await mountShell(runtime);
    await wrapper.get('[title="新建连接"]').trigger('click');
    await wrapper.get('[placeholder="例如：本地开发 Broker"]').setValue('Persistent new connection');
    await findButton(wrapper, '创建连接').trigger('click');
    await flushPromises();
    const created = runtime.calls.find(call => call[0] === 'connection.save')[1];
    expect(created.clean_session).toBe(0);
    expect(created.keepalive).toBe(120);
    await wrapper.findAll('.conn-item__edit')[0].trigger('click');
    await wrapper.get('[placeholder="例如：本地开发 Broker"]').setValue('Existing renamed');
    await findButton(wrapper, '保存').trigger('click');
    await flushPromises();
    const edited = runtime.calls.filter(call => call[0] === 'connection.save')[1][1];
    expect(edited.clean_session).toBe(1);
    wrapper.unmount();
  });

  it('resets each new subscription QoS to the current saved default', async () => {
    const runtime = createFakeRuntime({ settings: { defaultQos: 2 } });
    const wrapper = await mountShell(runtime);
    await wrapper.get('[title="添加订阅"]').trigger('click');
    expect(wrapper.get('[aria-label="订阅 QoS"]').element.value).toBe('2');
    await wrapper.get('[aria-label="订阅 QoS"]').setValue('0');
    await findButton(wrapper, '取消').trigger('click');
    await wrapper.get('[title="添加订阅"]').trigger('click');
    expect(wrapper.get('[aria-label="订阅 QoS"]').element.value).toBe('2');
    await wrapper.get('[placeholder="例如：device/sensor/#"]').setValue('default/qos');
    await findButton(wrapper, '确认订阅').trigger('click');
    await flushPromises();
    expect(runtime.calls.find(call => call[0] === 'subscription.add')[1].qos).toBe(2);

    await findButton(wrapper, '设置').trigger('click');
    await wrapper.get('[aria-label="默认 QoS"]').setValue('1');
    await wrapper.get('.settings-dialog').trigger('submit');
    await flushPromises();
    await wrapper.get('[title="添加订阅"]').trigger('click');
    expect(wrapper.get('[aria-label="订阅 QoS"]').element.value).toBe('1');
    wrapper.unmount();
  });

  it('stops scheduled publishing when changing connections and restores isolated topic drafts', async () => {
    vi.useFakeTimers();
    const runtime = createFakeRuntime({ connections: [connection('connection-1'), connection('connection-2')] });
    const wrapper = await mountShell(runtime);
    await connect(wrapper);
    await wrapper.get('#publish-topic').setValue('first/target');
    await findButton(wrapper, '定时发送').trigger('click');
    await findButton(wrapper, '开始').trigger('click');
    await wrapper.findAll('.conn-item__select')[1].trigger('click');
    await connect(wrapper);
    await wrapper.get('#publish-topic').setValue('second/target');
    await vi.advanceTimersByTimeAsync(6000);
    expect(runtime.calls.filter(call => call[0] === 'mqtt.publish')).toHaveLength(0);
    await wrapper.findAll('.conn-item__select')[0].trigger('click');
    expect(wrapper.get('#publish-topic').element.value).toBe('first/target');
    expect(wrapper.find('.publish-bar__timer--active').exists()).toBe(false);
    wrapper.unmount();
  });

});
