import { inject } from 'vue';
export const runtimeAdapterKey = Symbol('ineed-mqtt-runtime');
export function useRuntimeAdapter() {
  const adapter = inject(runtimeAdapterKey, null);
  if (!adapter) throw new Error('Ineed MQTT runtime adapter was not provided');
  return adapter;
}
