if (process.env.VITEST) {
  await import('./historyWindow.vitest.js');

  const [
    { createUnavailableRuntimeAdapter },
    { flushPromises, mount },
    { describe, expect, it, vi },
    { default: App },
    { runtimeAdapterKey },
  ] = await Promise.all([
    import('@ineed-mqtt-tool/runtime-contract'),
    import('@vue/test-utils'),
    import('vitest'),
    import('../../src/App.vue'),
    import('../../src/runtimeContext.js'),
  ]);

  describe('App history route', () => {
    it('queries the first messages page with the default page size', async () => {
      globalThis.window.history.replaceState({}, '', '/?history=messages');
      const adapter = createUnavailableRuntimeAdapter('component-test');
      adapter.connection.list = vi.fn(async () => []);
      adapter.history.queryMessages = vi.fn(async () => ({
        rows: [],
        total: 0,
        page: 1,
        pageSize: 100,
      }));

      const wrapper = mount(App, {
        global: {
          provide: { [runtimeAdapterKey]: adapter },
        },
      });
      await flushPromises();

      expect(wrapper.find('.history-page').exists()).toBe(true);
      expect(adapter.history.queryMessages).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 100 }),
      );
      wrapper.unmount();
    });
  });
}
