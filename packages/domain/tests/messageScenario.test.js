import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario, prepareScenario, evaluateAssertions, readField, scenarioExample } from '../src/messageScenario.js';

test('scenario whitelist excludes connection credentials and requires safe correlation path', () => {
  const result = normalizeScenario({ ...scenarioExample(), password: 'secret', connection: { password: 'secret' } });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  for (const path of ['__proto__.id', 'a.constructor.x', 'a[0]', '', 'a..b']) {
    assert.throws(() => normalizeScenario({ ...result, correlationPath: path }));
  }
  assert.equal(readField({ rows: [{ value: 2 }] }, 'rows.0.value'), 2);
  assert.equal(readField({}, 'toString'), undefined);
});

test('templates escape JSON variables and force unique request correlation without mutating snapshot', () => {
  const scenario = scenarioExample();
  scenario.variables = { device: 'unit-1', text: 'a"\\\nb' };
  scenario.payloadTemplate = '{"text":"{{text}}","requestId":"old","nested":{"id":"{{requestId}}"}}';
  const prepared = prepareScenario(scenario, 'unique-1');
  assert.equal(prepared.publishTopic, 'devices/unit-1/command');
  assert.deepEqual(JSON.parse(prepared.payload), { text: 'a"\\\nb', requestId: 'unique-1', nested: { id: 'unique-1' } });
  assert.equal(scenario.payloadTemplate.includes('"old"'), true);
  assert.throws(() => prepareScenario({ ...scenario, variables: { device: '+' } }, 'id'));
  assert.throws(() => prepareScenario({ ...scenario, payloadTemplate: '{"a":"{{missing}}"}' }, 'id'));
  assert.throws(() => prepareScenario({ ...scenario, variables: { requestId: 'fixed' } }, 'id'));
});

test('assertions are strict and missing, null and arrays retain JSON type semantics', () => {
  const rules = [
    { path: 'status', operator: 'equals', expected: 'ok' },
    { path: 'temperature', operator: 'range', min: 20, max: 30 },
    { path: 'items', operator: 'type', expected: 'array' },
    { path: 'nil', operator: 'type', expected: 'null' },
    { path: 'missing', operator: 'type', expected: 'string' },
    { path: 'temperature', operator: 'equals', expected: '25' },
  ];
  assert.deepEqual(evaluateAssertions({ status: 'ok', temperature: 25, items: [], nil: null }, rules).map(r => r.passed), [true,true,true,true,false,false]);
  assert.throws(() => normalizeScenario({ ...scenarioExample(), assertions: [{ path: 'x', operator: 'range', min: 10, max: 2 }] }));
  assert.throws(() => normalizeScenario({ ...scenarioExample(), timeoutMs: 0 }));
});
