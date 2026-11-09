import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTED_PROJECTIONS,
  runMqttRuntimeContract,
} from '../../../tooling/mqtt-load-test/runtimeContract.mjs';

const EXPECTED_SCENARIOS = Object.freeze([
  'plain-tcp-connect',
  'bad-credentials',
  'topic-filters',
  'unsubscribe-cancellation',
  'retained-late-subscribe',
  'binary-payload',
  'qos-boundaries',
  'clean-disconnect',
  'forced-drop-reconnect-resubscribe',
  'independent-connections',
]);

for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} production MQTT runtime satisfies the controlled broker contract`, {
    timeout: 120_000,
  }, async (context) => {
    const result = await runMqttRuntimeContract(runtime, {
      scenarioTimeoutMs: 10_000,
      onScenario(name, outcome) {
        context.diagnostic(`${runtime}:${name}:${outcome.ok ? 'ok' : outcome.error}`);
      },
    });

    assert.deepEqual(result.scenarios.map(({ name }) => name), EXPECTED_SCENARIOS);
    for (const scenario of result.scenarios) {
      assert.deepEqual(scenario.outcome, { ok: true }, `${runtime}:${scenario.name}`);
      assert.deepEqual(
        scenario.projection,
        EXPECTED_PROJECTIONS[scenario.name],
        `${runtime}:${scenario.name}:exact projection`,
      );
      assert.match(scenario.topicPrefix, /^contract\/[a-f0-9-]+$/u);
    }
    assert.deepEqual(result.cleanup, {
      brokerClosed: true,
      runtimeClosed: true,
      openSockets: 0,
    });
  });
}

test('two consecutive controlled brokers select released loopback ports', {
  timeout: 20_000,
}, async () => {
  const { startLocalBroker } = await import('../../../tooling/mqtt-load-test/localBroker.mjs');
  const first = await startLocalBroker();
  const firstPort = first.port;
  const firstClose = first.close();
  assert.equal(first.close(), firstClose);
  await firstClose;
  const second = await startLocalBroker();
  try {
    assert.equal(first.host, '127.0.0.1');
    assert.equal(second.host, '127.0.0.1');
    assert.ok(Number.isInteger(firstPort) && firstPort > 0);
    assert.ok(Number.isInteger(second.port) && second.port > 0);
    assert.equal(first.openSocketCount, 0);
  } finally {
    const secondClose = second.close();
    assert.equal(second.close(), secondClose);
    await secondClose;
  }
  assert.equal(second.openSocketCount, 0);
});
