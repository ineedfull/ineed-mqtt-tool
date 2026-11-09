import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  SVGElement: dom.window.SVGElement,
  window: dom.window,
});

const [{ mount }, runtimeContext] = await Promise.all([
  import('@vue/test-utils'),
  import('../src/runtimeContext.js'),
]);

const { runtimeAdapterKey, useRuntimeAdapter } = runtimeContext;

test('runtime adapter injection key is a stable symbol', async () => {
  const secondImport = await import('../src/runtimeContext.js');

  assert.equal(typeof runtimeAdapterKey, 'symbol');
  assert.equal(runtimeAdapterKey.description, 'ineed-mqtt-runtime');
  assert.equal(secondImport.runtimeAdapterKey, runtimeAdapterKey);
});

test('useRuntimeAdapter returns the exact provided adapter from a mounted component', () => {
  const adapter = { runtimeName: 'provided' };
  let observedAdapter;
  const Probe = {
    setup() {
      observedAdapter = useRuntimeAdapter();
      return () => null;
    },
  };

  const wrapper = mount(Probe, {
    global: {
      provide: {
        [runtimeAdapterKey]: adapter,
      },
    },
  });

  assert.equal(observedAdapter, adapter);
  wrapper.unmount();
});

test('useRuntimeAdapter throws the exact error when no adapter was provided', () => {
  const originalWarn = console.warn;
  let warningCalls = 0;
  let wrapper;
  const Probe = {
    setup() {
      assert.throws(
        () => useRuntimeAdapter(),
        new Error('Ineed MQTT runtime adapter was not provided'),
      );
      return () => null;
    },
  };

  console.warn = () => {
    warningCalls += 1;
  };
  try {
    wrapper = mount(Probe);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warningCalls, 0);
  assert.equal(console.warn, originalWarn);
  wrapper.unmount();
});
