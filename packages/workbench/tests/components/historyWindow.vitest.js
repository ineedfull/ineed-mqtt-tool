import { createUnavailableRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HistoryWindow from '../../src/layouts/HistoryWindow.vue';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';

function message(id, topic = `devices/${id}`) {
  return {
    id,
    conn_id: 'connection-1',
    created_at: '2026-07-23 10:20:30.123',
    direction: 'in',
    format: 'text',
    payload: `payload-${id}`,
    qos: 0,
    retained: 0,
    topic,
  };
}

function page(rows) {
  return { rows, total: rows.length, page: 1, pageSize: 100 };
}

function createFakeRuntime() {
  const adapter = createUnavailableRuntimeAdapter('history-window-test');
  let listConnections = async () => [{ id: 'connection-1', name: 'Connection 1' }];
  let queryMessages = async () => page([]);
  let deleteMessage = async () => ({ ok: true });
  let clearMessages = async () => ({ ok: true });

  adapter.connection.list = (...args) => listConnections(...args);
  adapter.history.queryMessages = (...args) => queryMessages(...args);
  adapter.history.deleteMessage = (...args) => deleteMessage(...args);
  adapter.history.clearMessages = (...args) => clearMessages(...args);
  adapter.clipboard.writeText = async () => ({ ok: true });

  return {
    adapter,
    setConnections(next) {
      listConnections = next;
    },
    setQuery(next) {
      queryMessages = next;
    },
    setDelete(next) {
      deleteMessage = next;
    },
    setClear(next) {
      clearMessages = next;
    },
  };
}

function mountHistory(adapter) {
  return mount(HistoryWindow, {
    global: {
      provide: { [runtimeAdapterKey]: adapter },
    },
  });
}

async function mountWithRows(runtime, rows = [message(1)]) {
  runtime.setQuery(async () => page(rows));
  const wrapper = mountHistory(runtime.adapter);
  await flushPromises();
  return wrapper;
}

describe('HistoryWindow async operations', () => {
  it('shows the legacy clock and missing-date notice for a Tauri log with empty created_at', async () => {
    globalThis.window.history.replaceState({}, '', '/?history=logs&connId=connection-1');
    const runtime = createFakeRuntime();
    const row = { id: 7, connection_id: 'connection-1', time: '14:38:12.7', level: 'debug', msg: 'legacy log', created_at: '' };
    runtime.adapter.history.queryLogs = async () => page([row]);
    const wrapper = mountHistory(runtime.adapter);
    await flushPromises();
    const time = wrapper.get('.history-row > span');
    expect(time.text()).toBe('14:38:12.700');
    expect(time.attributes('title')).toBe('旧记录无日期');
    expect(wrapper.get('.history-detail__identity').text()).toContain('14:38:12.700');
    expect(wrapper.get('.history-detail__identity').text()).toContain('旧记录无日期');
    expect(row.created_at).toBe('');
    wrapper.unmount();
  });
  it('identifies a legacy clock as lacking a date without inventing one', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountWithRows(runtime, [{ ...message(1), created_at: null, time: '14:38:12.7' }]);
    const time = wrapper.get('.history-row > span');
    expect(time.text()).toBe('14:38:12.700');
    expect(time.attributes('title')).toBe('旧记录无日期');
    expect(wrapper.get('.history-detail__identity').text()).toContain('旧记录无日期');
    expect(wrapper.get('.history-detail__identity').text()).not.toContain('2026-');
    wrapper.unmount();
  });
  beforeEach(() => {
    globalThis.window.history.replaceState({}, '', '/?history=messages&connId=connection-1');
    vi.spyOn(globalThis.window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads saved font preferences and refreshes them when history regains focus', async () => {
    const runtime = createFakeRuntime();
    runtime.adapter.settings.getAll = vi.fn(async () => ({ largeFont: 'true' }));
    const wrapper = await mountWithRows(runtime);
    expect(wrapper.classes()).toContain('large-font');

    runtime.adapter.settings.getAll.mockResolvedValue({ largeFont: false });
    globalThis.window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.classes()).not.toContain('large-font');
    wrapper.unmount();
    const calls = runtime.adapter.settings.getAll.mock.calls.length;
    globalThis.window.dispatchEvent(new Event('focus'));
    expect(runtime.adapter.settings.getAll).toHaveBeenCalledTimes(calls);
  });

  it('ignores stale font preferences and keeps history usable if settings cannot be read', async () => {
    const runtime = createFakeRuntime();
    let resolveInitial;
    runtime.adapter.settings.getAll = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }))
      .mockResolvedValue({ largeFont: true });
    const wrapper = await mountWithRows(runtime);
    globalThis.window.dispatchEvent(new Event('focus'));
    await flushPromises();
    resolveInitial({ largeFont: false });
    await flushPromises();
    expect(wrapper.classes()).toContain('large-font');

    runtime.adapter.settings.getAll.mockRejectedValue(new Error('settings unavailable'));
    globalThis.window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.classes()).toContain('large-font');
    expect(wrapper.find('.history-error').exists()).toBe(false);
    expect(wrapper.findAll('.history-row')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows a retryable error and clears loading when the row query fails', async () => {
    const runtime = createFakeRuntime();
    runtime.setQuery(async () => {
      throw new Error('history query unavailable');
    });

    const wrapper = mountHistory(runtime.adapter);
    await flushPromises();

    expect(wrapper.get('.history-error').attributes('role')).toBe('alert');
    expect(wrapper.get('.history-error').text()).toContain('history query unavailable');
    expect(wrapper.get('.history-retry').text()).toContain('重试');
    expect(wrapper.find('.history-loading').exists()).toBe(false);
    expect(wrapper.get('.history-search').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('catches an initial connection-list failure and retries initialization', async () => {
    const runtime = createFakeRuntime();
    runtime.setConnections(async () => {
      throw new Error('connection list unavailable');
    });
    const wrapper = mountHistory(runtime.adapter);
    await flushPromises();

    expect(wrapper.get('.history-error').text()).toContain('connection list unavailable');

    runtime.setConnections(async () => [{ id: 'connection-1', name: 'Recovered' }]);
    runtime.setQuery(async () => page([message(2)]));
    await wrapper.get('.history-retry').trigger('click');
    await flushPromises();

    expect(wrapper.find('.history-error').exists()).toBe(false);
    expect(wrapper.text()).toContain('devices/2');
    wrapper.unmount();
  });

  it('keeps the newest rows when an older overlapping query resolves last', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountWithRows(runtime);
    const older = Promise.withResolvers();
    const newer = Promise.withResolvers();
    runtime.setQuery(() => older.promise);

    wrapper.get('.history-search').element.click();
    runtime.setQuery(() => newer.promise);
    wrapper.get('.history-search').element.click();

    newer.resolve(page([message(3, 'newest/topic')]));
    await flushPromises();
    expect(wrapper.text()).toContain('newest/topic');

    older.resolve(page([message(4, 'stale/topic')]));
    await flushPromises();
    expect(wrapper.text()).toContain('newest/topic');
    expect(wrapper.text()).not.toContain('stale/topic');
    wrapper.unmount();
  });

  it('ignores a stale rejection after the current query succeeds', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountWithRows(runtime);
    const older = Promise.withResolvers();
    const newer = Promise.withResolvers();
    runtime.setQuery(() => older.promise);

    wrapper.get('.history-search').element.click();
    runtime.setQuery(() => newer.promise);
    wrapper.get('.history-search').element.click();

    newer.resolve(page([message(5, 'current/topic')]));
    await flushPromises();
    older.reject(new Error('stale query failed'));
    await flushPromises();

    expect(wrapper.text()).toContain('current/topic');
    expect(wrapper.find('.history-error').exists()).toBe(false);
    expect(wrapper.find('.history-loading').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows delete failures, preserves the row, and re-enables mutation controls', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountWithRows(runtime);
    runtime.setDelete(async () => {
      throw new Error('delete failed');
    });

    await wrapper.get('.history-delete').trigger('click');
    await flushPromises();

    expect(wrapper.get('.history-error').text()).toContain('delete failed');
    expect(wrapper.text()).toContain('devices/1');
    expect(wrapper.get('.history-delete').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('shows clear failures, preserves rows, and re-enables mutation controls', async () => {
    const runtime = createFakeRuntime();
    const wrapper = await mountWithRows(runtime);
    runtime.setClear(async () => {
      throw new Error('clear failed');
    });

    await wrapper.get('.history-clear').trigger('click');
    await flushPromises();

    expect(wrapper.get('.history-error').text()).toContain('clear failed');
    expect(wrapper.text()).toContain('devices/1');
    expect(wrapper.get('.history-clear').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('reloads rows after a successful delete', async () => {
    const runtime = createFakeRuntime();
    let queryCount = 0;
    runtime.setQuery(async () => {
      queryCount += 1;
      return queryCount === 1 ? page([message(7)]) : page([]);
    });
    const deletedIds = [];
    runtime.setDelete(async id => {
      deletedIds.push(id);
      return { ok: true };
    });
    const wrapper = mountHistory(runtime.adapter);
    await flushPromises();

    await wrapper.get('.history-delete').trigger('click');
    await flushPromises();

    expect(deletedIds).toEqual([7]);
    expect(queryCount).toBe(2);
    expect(wrapper.get('.msg-empty').text()).toContain('暂无历史记录');
    expect(wrapper.find('.history-detail__footer').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not apply a deferred response after unmount', async () => {
    const runtime = createFakeRuntime();
    const deferred = Promise.withResolvers();
    runtime.setQuery(() => deferred.promise);
    const wrapper = mountHistory(runtime.adapter);
    await flushPromises();
    const setupState = wrapper.vm.$.setupState;

    wrapper.unmount();
    deferred.resolve(page([message(8, 'after/unmount')]));
    await flushPromises();

    expect(setupState.rows).toEqual([]);
    expect(setupState.loading).toBe(true);
  });

  it('replaces the copy feedback timer and clears it on unmount', async () => {
    vi.useFakeTimers();
    const runtime = createFakeRuntime();
    const wrapper = await mountWithRows(runtime);

    await wrapper.get('[title="复制主题"]').trigger('click');
    await flushPromises();
    await wrapper.get('[title="复制内容"]').trigger('click');
    await flushPromises();

    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
