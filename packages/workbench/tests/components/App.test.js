if (process.env.VITEST) {
  const [
    { createUnavailableRuntimeAdapter },
    { flushPromises, mount },
    { afterEach, beforeEach, describe, expect, it, vi },
    { default: App },
    { runtimeAdapterKey },
  ] = await Promise.all([
    import('@ineed-mqtt-tool/runtime-contract'),
    import('@vue/test-utils'),
    import('vitest'),
    import('../../src/App.vue'),
    import('../../src/runtimeContext.js'),
  ]);

  describe('App runtime-neutral main view', () => {
    beforeEach(() => {
      globalThis.window.history.replaceState({}, '', '/');
      delete globalThis.window.ineedMqtt;
      delete globalThis.window.__TAURI__;
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('loads empty connections through the provided adapter without native globals', async () => {
      const adapter = createUnavailableRuntimeAdapter('component-test');
      adapter.connection.list = vi.fn(async () => []);

      const wrapper = mount(App, {
        global: {
          provide: { [runtimeAdapterKey]: adapter },
        },
      });
      await flushPromises();

      expect(adapter.connection.list).toHaveBeenCalledOnce();
      expect(wrapper.get('.workspace-state--empty').text()).toContain('暂无连接');
      expect(globalThis.window.ineedMqtt).toBeUndefined();
      expect(globalThis.window.__TAURI__).toBeUndefined();

      wrapper.unmount();
      await flushPromises();
    });
  });
}
