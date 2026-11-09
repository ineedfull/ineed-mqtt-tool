import { createUnavailableRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MqttToolShell from '../../src/layouts/MqttToolShell.vue';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';

function connection(id, host = `${id}.example.com`) {
  return {
    id,
    name: id,
    host,
    port: 1883,
    protocol: 'mqtt',
  };
}

function createFakeRuntime(initialList) {
  const adapter = createUnavailableRuntimeAdapter('workspace-test');
  let list = initialList;
  const listCalls = [];

  adapter.connection.list = (...args) => {
    listCalls.push(args);
    return list(...args);
  };
  adapter.connection.messageCounts = async () => [];
  adapter.subscription.list = async () => [];
  adapter.subscription.add = async () => ({ ok: true });
  adapter.settings.getAll = async () => ({});
  adapter.settings.save = async () => ({ ok: true });
  adapter.mqtt.disconnect = async () => ({ ok: true });

  return {
    adapter,
    listCalls,
    setList(nextList) {
      list = nextList;
    },
  };
}

function mountShell(adapter) {
  return shallowMount(MqttToolShell, {
    global: {
      provide: { [runtimeAdapterKey]: adapter },
      stubs: { PayloadEditor: true },
    },
  });
}

describe('workspace loading states', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders only accessible loading status while the database is pending', async () => {
    const pending = Promise.withResolvers();
    const runtime = createFakeRuntime(() => pending.promise);
    const wrapper = mountShell(runtime.adapter);
    await flushPromises();

    expect(wrapper.get('.workspace-state--loading').attributes('role')).toBe('status');
    expect(wrapper.text()).toContain('正在加载工作区...');
    expect(wrapper.text()).not.toContain('mqtt://undefined');
    expect(wrapper.find('.status-bar').exists()).toBe(false);
    expect(wrapper.find('.publish-bar__send').exists()).toBe(false);

    wrapper.unmount();
    await flushPromises();
  });

  it('renders a retryable error and loads the connection after retry', async () => {
    const runtime = createFakeRuntime(async () => {
      throw new Error('database offline');
    });
    const wrapper = mountShell(runtime.adapter);
    await flushPromises();

    const error = wrapper.get('.workspace-state--error');
    expect(error.attributes('role')).toBe('alert');
    expect(error.text()).toContain('database offline');
    expect(wrapper.find('.status-bar').exists()).toBe(false);

    runtime.setList(async () => [connection('retry')]);
    await wrapper.get('.workspace-state__retry').trigger('click');
    await flushPromises();

    expect(wrapper.find('.workspace-state--error').exists()).toBe(false);
    expect(wrapper.get('.status-bar__url').text()).toBe('mqtt://retry.example.com:1883');
    expect(wrapper.text()).toContain('retry');
    wrapper.unmount();
  });

  it('ignores a timed-out request that settles after a successful retry', async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers();
    const runtime = createFakeRuntime(() => first.promise);
    const wrapper = mountShell(runtime.adapter);
    await flushPromises();

    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(wrapper.get('.workspace-state--error').text()).toContain('工作区数据加载超时');

    runtime.setList(async () => [connection('newer')]);
    await wrapper.get('.workspace-state__retry').trigger('click');
    await flushPromises();
    expect(wrapper.get('.status-bar__url').text()).toContain('newer.example.com');

    first.resolve([connection('stale')]);
    await flushPromises();
    expect(wrapper.get('.status-bar__url').text()).toContain('newer.example.com');
    expect(wrapper.text()).not.toContain('stale.example.com');
    wrapper.unmount();
  });

  it('renders a coherent empty state with new connection access', async () => {
    const runtime = createFakeRuntime(async () => []);
    const wrapper = mountShell(runtime.adapter);
    await flushPromises();

    expect(wrapper.get('.workspace-state--empty').text()).toContain('暂无连接');
    expect(wrapper.text()).not.toContain('undefined');
    expect(wrapper.find('.status-bar').exists()).toBe(false);
    expect(wrapper.find('.publish-bar__send').exists()).toBe(false);

    await wrapper.get('.workspace-state__new-connection').trigger('click');
    expect(wrapper.find('.modal-overlay').exists()).toBe(true);
    wrapper.unmount();
  });
});
