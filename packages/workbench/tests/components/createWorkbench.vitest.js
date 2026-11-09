import { createUnavailableRuntimeAdapter } from '@ineed-mqtt-tool/runtime-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAppSpy = vi.hoisted(() => vi.fn());

vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal();
  createAppSpy.mockImplementation(vue.createApp);
  return { ...vue, createApp: createAppSpy };
});

import { createWorkbench } from '../../src/createWorkbench.js';
import { runtimeAdapterKey } from '../../src/runtimeContext.js';

describe('createWorkbench', () => {
  beforeEach(() => {
    createAppSpy.mockClear();
  });

  it('validates the runtime adapter before creating the Vue app', () => {
    const adapter = createUnavailableRuntimeAdapter('incomplete');
    delete adapter.mqtt.publish;

    expect(() => createWorkbench(adapter)).toThrowError(
      'Runtime adapter is missing required methods: mqtt.publish',
    );
    expect(createAppSpy).not.toHaveBeenCalled();
  });

  it('returns an unmounted Vue app with the runtime adapter provided', () => {
    const adapter = createUnavailableRuntimeAdapter('test-runtime');

    const app = createWorkbench(adapter);

    expect(createAppSpy).toHaveBeenCalledOnce();
    expect(app._context.provides[runtimeAdapterKey]).toBe(adapter);
    expect(app._container).toBeNull();
  });

  it('uses the runtime contract runtimeName validation', () => {
    const adapter = createUnavailableRuntimeAdapter('test-runtime');
    adapter.runtimeName = '   ';

    expect(() => createWorkbench(adapter)).toThrowError(
      'Runtime adapter must have a nonblank own data runtimeName',
    );
    expect(createAppSpy).not.toHaveBeenCalled();
  });
});
