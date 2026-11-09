import assert from 'node:assert/strict';
import test from 'node:test';

import { createEditConnectionDraft, normalizeRuntimeConnection, toDbConnection } from '../../../packages/domain/src/connectionModel.js';
import { startLocalBroker } from '../../../tooling/mqtt-load-test/localBroker.mjs';
import { createTauriHarness } from '../../../tooling/mqtt-load-test/tauriHarness.mjs';
import { createTauriRuntimeAdapter } from '../renderer/runtimeAdapter.js';

test('an edited persisted connection reconnects through the Tauri adapter and actual Rust service', { timeout: 150_000 }, async t => {
  const broker = await startLocalBroker();
  let native;
  t.after(async () => {
    try { await native?.close(); }
    finally { await broker.close(); }
  });
  native = await createTauriHarness();
  const adapter = createTauriRuntimeAdapter({
    invoke(command, { conn, connId }) {
      if (command === 'mqtt_connect') return native.command('connect', conn);
      if (command === 'mqtt_disconnect') return native.command('disconnect', connId);
      throw new Error(`Unexpected command: ${command}`);
    },
    listen: async () => () => {},
    readText: () => '',
    writeText: () => {},
  });
  const saved = toDbConnection({
    id: 'edited-native', name: 'Local connection', ...broker,
    protocol: 'mqtt://', clientId: 'before-edit', cleanSession: 1,
  });
  // Use the same saved-row + draft merge as the workbench edit path.
  const loaded = normalizeRuntimeConnection(saved);
  assert.equal((await adapter.mqtt.connect(loaded)).ok, true);
  await broker.waitForClient('before-edit');
  assert.equal((await adapter.mqtt.disconnect(loaded.id)).ok, true);

  const edited = {
    ...loaded, ...createEditConnectionDraft(loaded),
    clientId: 'after-edit', cleanSession: 0,
  };
  const result = await adapter.mqtt.connect(edited);
  assert.equal(result.ok, true, result.error);
  await broker.waitForClient('after-edit');
  assert.equal((await adapter.mqtt.disconnect(edited.id)).ok, true);
});
