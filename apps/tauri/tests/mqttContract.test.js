import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(TEST_DIR, '..', 'src-tauri', 'src');
const WORKBENCH_SHELL = join(
  TEST_DIR,
  '..',
  '..',
  '..',
  'packages',
  'workbench',
  'src',
  'layouts',
  'MqttToolShell.vue',
);
const MQTT_COMMANDS = [
  'mqtt_connect',
  'mqtt_disconnect',
  'mqtt_subscribe',
  'mqtt_unsubscribe',
  'mqtt_publish',
];

async function source(name) {
  return readFile(join(SOURCE_DIR, name), 'utf8');
}

function tokenizeRust(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    const ignored = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/u.exec(rest);
    if (ignored) {
      index += ignored[0].length;
      continue;
    }
    const string = /^(?:b|r|br)?(?:#+)?"(?:\\.|[^"\\])*"(?:#+)?/u.exec(rest);
    if (string) {
      tokens.push({ type: 'string', value: string[0] });
      index += string[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const punctuation = /^::|^->|^=>|^>=|^==|^./su.exec(rest)[0];
    tokens.push({ type: 'punctuation', value: punctuation });
    index += punctuation.length;
  }
  return tokens;
}

function rustFunctionTokens(input, name) {
  const tokens = tokenizeRust(input);
  const functionIndex = tokens.findIndex((token, index) => (
    token.value === 'fn' && tokens[index + 1]?.value === name
  ));
  assert.notEqual(functionIndex, -1, `Rust function ${name} must exist`);
  const bodyStart = tokens.findIndex(
    (token, index) => index > functionIndex && token.value === '{',
  );
  assert.notEqual(bodyStart, -1, `Rust function ${name} must have a body`);
  let depth = 1;
  for (let index = bodyStart + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === '{') depth += 1;
    if (tokens[index].value === '}') depth -= 1;
    if (depth === 0) return tokens.slice(bodyStart + 1, index);
  }
  assert.fail(`Rust function ${name} body must be balanced`);
}

function values(tokens) {
  return tokens.map(token => token.value);
}

function containsSequence(tokens, expected) {
  const actual = values(tokens);
  return actual.some((_, index) => (
    expected.every((value, offset) => actual[index + offset] === value)
  ));
}

function parseGenerateHandlerCommands(input) {
  const tokens = tokenizeRust(input);
  const start = tokens.findIndex((token, index) => (
    token.value === 'generate_handler'
      && tokens[index + 1]?.value === '!'
      && tokens[index + 2]?.value === '['
  ));
  assert.notEqual(start, -1, 'generate_handler! macro must exist');
  const commands = [];
  let depth = 1;
  let segment = [];
  for (let index = start + 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '[') depth += 1;
    if (token.value === ']') depth -= 1;
    if (depth === 0 || (depth === 1 && token.value === ',')) {
      const identifiers = segment
        .filter(part => part.type === 'identifier')
        .map(part => part.value);
      if (identifiers.length > 0) commands.push(identifiers.at(-1));
      segment = [];
      if (depth === 0) break;
      continue;
    }
    segment.push(token);
  }
  assert.equal(depth, 0, 'generate_handler! macro must be balanced');
  return commands;
}

test('production and test builds use the same MQTT module and exact native handlers', async () => {
  const lib = await source('lib.rs');
  const commands = parseGenerateHandlerCommands(lib);

  assert.doesNotMatch(lib, /#\[cfg\(not\(test\)\)\][\s\S]{0,40}(?:mod mqtt|use mqtt::MqttService|pub fn run)/u);
  assert.deepEqual(commands.filter(command => command.startsWith('mqtt_')), MQTT_COMMANDS);
  assert.equal(new Set(commands).size, commands.length);
});

test('native boundary exposes stable commands without leaking rumqttc types', async () => {
  const mqtt = await source('mqtt.rs');
  const expectedParameters = new Map([
    ['mqtt_connect', ['app', 'service', 'conn']],
    ['mqtt_disconnect', ['app', 'service', 'conn_id']],
    ['mqtt_subscribe', ['service', 'conn_id', 'topic', 'qos']],
    ['mqtt_unsubscribe', ['service', 'conn_id', 'topic']],
    ['mqtt_publish', ['service', 'conn_id', 'topic', 'payload', 'qos', 'retain']],
  ]);

  for (const [name, parameters] of expectedParameters) {
    const tokens = tokenizeRust(mqtt);
    const fnIndex = tokens.findIndex((token, index) => token.value === 'fn' && tokens[index + 1]?.value === name);
    assert.notEqual(fnIndex, -1, `${name} must exist`);
    const open = tokens.findIndex((token, index) => index > fnIndex && token.value === '(');
    const close = tokens.findIndex((token, index) => index > open && token.value === ')');
    const actual = tokens.slice(open + 1, close)
      .filter((token, index, parts) => token.type === 'identifier' && parts[index + 1]?.value === ':')
      .map(token => token.value);
    assert.deepEqual(actual, parameters, `${name} parameter contract`);
  }
  const resultTokens = tokenizeRust(mqtt);
  const resultStart = resultTokens.findIndex((token, index) => (
    token.value === 'struct' && resultTokens[index + 1]?.value === 'MqttCommandResult'
  ));
  const resultFields = resultTokens.slice(resultStart, resultStart + 40);
  assert.ok(containsSequence(resultFields, ['ok', ':', 'bool', ',']));
  assert.ok(containsSequence(resultFields, ['error', ':', 'Option', '<', 'String', '>']));
  assert.doesNotMatch(mqtt, /pub async fn mqtt_[\s\S]*Result<\s*(?:QoS|MqttOptions|AsyncClient|EventLoop)/u);
});

test('MQTT events use exact names and camelCase message and status contracts', async () => {
  const mqtt = await source('mqtt.rs');
  const eventStrings = tokenizeRust(mqtt)
    .filter(token => token.type === 'string' && /^"mqtt:[a-z]/u.test(token.value))
    .map(token => token.value.slice(1, -1));

  assert.deepEqual([...new Set(eventStrings)].sort(), ['mqtt:messages', 'mqtt:status']);
  assert.match(mqtt, /struct MqttMessageEvent\s*\{[\s\S]*conn_id:[\s\S]*topic:[\s\S]*payload:[\s\S]*payload_hex:[\s\S]*qos:[\s\S]*retained:[\s\S]*time:[\s\S]*byte_length:/u);
  assert.match(mqtt, /struct MqttStatusEvent\s*\{[\s\S]*conn_id:[\s\S]*status:[\s\S]*error:[\s\S]*diagnostic:[\s\S]*reconnected:[\s\S]*attempt:[\s\S]*next_delay_ms:/u);
  assert.ok((mqtt.match(/#\[serde\(rename_all = "camelCase"\)\]/gu) || []).length >= 3);
});

test('runtime enforces 200-row bounded batches and the 8 MiB pre-queue payload cap', async () => {
  const mqtt = await source('mqtt.rs');

  assert.match(mqtt, /const MAX_MESSAGE_BATCH_SIZE:\s*usize\s*=\s*200\s*;/u);
  assert.match(mqtt, /const MAX_INBOUND_PAYLOAD_BYTES:\s*usize\s*=\s*8\s*\*\s*1024\s*\*\s*1024\s*;/u);
  const push = rustFunctionTokens(mqtt, 'push');
  assert.ok(containsSequence(push, ['payload_bytes', '>', 'MAX_INBOUND_PAYLOAD_BYTES']));
  assert.ok(containsSequence(push, ['items', '.', 'len', '(', ')', '>=', 'MAX_MESSAGE_BATCH_SIZE']));
  assert.match(mqtt, /Duration::from_millis\(200\)/u);
  assert.match(mqtt, /PAYLOAD_TOO_LARGE/u);
});

test('generation guards and idempotent bounded stopping protect replacement and late batches', async () => {
  const mqtt = await source('mqtt.rs');
  const cleanup = rustFunctionTokens(mqtt, 'remove_identity_if_current');
  const stop = rustFunctionTokens(mqtt, 'stop_handle');
  const disconnect = rustFunctionTokens(mqtt, 'disconnect');

  assert.ok(containsSequence(cleanup, ['state', '.', 'get', '(', 'conn_id', ')', '==', 'Some', '(', '&', 'generation', ')']));
  assert.ok(containsSequence(stop, ['timeout', '(']));
  assert.ok(containsSequence(stop, [
    'timeout', '(', 'SHUTDOWN_TIMEOUT', ',', 'handle', '.', 'client', '.', 'disconnect', '(', ')',
  ]), 'disconnect queueing must be bounded');
  const disconnectEmit = disconnect.findIndex(token => token.value === 'emit_disconnected');
  const disconnectStop = disconnect.findIndex(token => token.value === 'stop_handle');
  const disconnectBegin = disconnect.findIndex(token => token.value === 'begin_stop');
  assert.ok(disconnectBegin >= 0 && disconnectEmit > disconnectBegin && disconnectStop > disconnectEmit,
    'stopping transition and guarded disconnected status must precede task stopping');
  assert.match(mqtt, /enum GuardPhase\s*\{[\s\S]*Active[\s\S]*Stopping[\s\S]*Inactive/u);
  assert.match(mqtt, /fn allows_batch\(/u);
  assert.match(mqtt, /fn allows_status\(/u);
});

test('connection timeout emits its terminal diagnostic before stopping the guarded task', async () => {
  const mqtt = await source('mqtt.rs');
  const connect = rustFunctionTokens(mqtt, 'connect');
  const timeoutMatch = connect.findIndex((token, index) => (
    token.value === 'timeout'
      && connect[index + 1]?.value === '('
      && connect[index + 2]?.value === 'CONNECT_TIMEOUT'
  ));
  const timeoutArm = connect.findLastIndex((token, index) => (
    index > timeoutMatch
      && token.value === 'Err'
      && connect[index + 1]?.value === '('
      && connect[index + 2]?.value === '_'
  ));
  const take = connect.findIndex((token, index) => index > timeoutArm && token.value === 'take_generation');
  const emit = connect.findIndex((token, index) => (
    index > timeoutArm && token.value === 'emit_terminal_diagnostic'
  ));
  const stop = connect.findIndex((token, index) => index > timeoutArm && token.value === 'stop_handle');

  assert.ok(timeoutMatch >= 0 && timeoutArm > timeoutMatch);
  assert.ok(take > timeoutArm && emit > take && stop > emit,
    'timeout must take and stop the generation before its terminal diagnostic and guarded stop');
});

test('subscribe and unsubscribe complete only after matching broker acknowledgements', async () => {
  const mqtt = await source('mqtt.rs');
  const eventLoop = rustFunctionTokens(mqtt, 'run_event_loop');
  const unsubscribe = rustFunctionTokens(mqtt, 'unsubscribe');
  const operation = rustFunctionTokens(mqtt, 'subscription_operation');

  assert.ok(containsSequence(eventLoop, ['Outgoing', '::', 'Subscribe', '(']));
  assert.ok(containsSequence(eventLoop, ['Packet', '::', 'SubAck', '(']));
  assert.ok(containsSequence(eventLoop, ['Outgoing', '::', 'Unsubscribe', '(']));
  assert.ok(containsSequence(eventLoop, ['Packet', '::', 'UnsubAck', '(']));
  assert.ok(containsSequence(operation, ['client', '.', 'unsubscribe', '(']));
  assert.ok(containsSequence(unsubscribe, ['self', '.', 'subscription_operation', '(']));
  assert.equal(containsSequence(unsubscribe, ['self', '.', 'disconnect', '(']), false);
  assert.match(mqtt, /subscribe timeout/u);
  assert.match(mqtt, /unsubscribe timeout/u);
});

test('publish preserves string and binary payloads and forwards QoS and retain', async () => {
  const mqtt = await source('mqtt.rs');
  const payload = rustFunctionTokens(mqtt, 'into_bytes');
  const publish = rustFunctionTokens(mqtt, 'publish');

  assert.ok(containsSequence(payload, ['Self', '::', 'Text', '(', 'value', ')', '=>', 'value', '.', 'into_bytes', '(', ')']));
  assert.ok(containsSequence(payload, ['Self', '::', 'Bytes', '(', 'value', ')', '=>', 'value']));
  assert.ok(containsSequence(publish, ['client', '.', 'publish', '(']));
  assert.ok(values(publish).includes('retain'));
  assert.match(mqtt, /enum PublishPayload\s*\{\s*Text\(String\),\s*Bytes\(Vec<u8>\)/su);
});

test('workbench consumes reconnect, subscription, and binary-message runtime semantics', async () => {
  const [shell, lifecycle] = await Promise.all([
    readFile(WORKBENCH_SHELL, 'utf8'),
    readFile(join(dirname(WORKBENCH_SHELL), '..', 'workspace', 'subscriptionLifecycle.js'), 'utf8'),
  ]);

  assert.match(lifecycle, /mqttApi\.subscribe\(/u);
  assert.match(lifecycle, /mqttApi\.unsubscribe\(/u);
  assert.match(shell, /createSubscriptionLifecycle\(\{/u);
  assert.match(shell, /subscriptionLifecycle\.restoreConnectionSubscriptions\(event\.connId\)/u);
  assert.match(shell, /event\.status === 'connected' && event\.reconnected/u);
  assert.match(shell, /mqttApi\?\.onMessages\(processIncomingMessages\)/u);
  assert.match(shell, /mqttApi\?\.onStatus\(handleMqttStatus\)/u);
});
