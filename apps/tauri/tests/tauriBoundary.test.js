import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = join(TEST_DIR, '..', 'src-tauri');
const SOURCE_DIR = join(TAURI_DIR, 'src');
const { version: productVersion } = JSON.parse(await readFile(join(TEST_DIR, '../../..', 'package.json'), 'utf8'));

const DATABASE_COMMANDS = [
  'db_get_connections',
  'db_save_connection',
  'db_delete_connection',
  'db_get_message_counts',
  'db_get_subscriptions',
  'db_add_subscription',
  'db_remove_subscription',
  'db_save_messages',
  'db_save_logs',
  'db_query_history_messages',
  'db_delete_history_message',
  'db_clear_history_messages',
  'db_query_history_logs',
  'db_delete_history_log',
  'db_clear_history_logs',
  'db_get_publish_history',
  'db_save_publish',
  'db_get_all_settings',
  'db_save_setting',
  'db_get_storage_stats',
  'db_clear_history_storage',
];

const MQTT_COMMANDS = [
  'mqtt_connect',
  'mqtt_disconnect',
  'mqtt_subscribe',
  'mqtt_unsubscribe',
  'mqtt_publish',
];

const NATIVE_COMMANDS = [
  'window_open_history',
  'window_open_external',
  'window_close_ready',
  'update_check',
  'update_state',
  'update_download',
  'update_cancel',
  'update_install',
  'update_prepare_ready',
];

const EXPECTED_COMMANDS = [...DATABASE_COMMANDS, ...MQTT_COMMANDS, ...NATIVE_COMMANDS].sort();

const REQUIRED_ICONS = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.icns',
  'icon.ico',
  'icon.png',
];

// Bundle uses the cross-platform defaults; the build script also tracks the
// generated source/legacy PNGs so regenerating any icon invalidates the build.
const BUNDLE_ICONS = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico'];

async function readSource(name) {
  return readFile(join(SOURCE_DIR, name), 'utf8');
}

function tokenizeRust(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    const lineComment = /^\/\/[^\n]*/.exec(rest);
    if (lineComment) {
      index += lineComment[0].length;
      continue;
    }
    const blockComment = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (blockComment) {
      index += blockComment[0].length;
      continue;
    }
    const string = /^(?:b|r|br)?(?:#+)?"(?:\\.|[^"\\])*"(?:#+)?/.exec(rest);
    if (string) {
      tokens.push({ type: 'string', value: string[0] });
      index += string[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const punctuation = /^::|^./s.exec(rest)[0];
    tokens.push({ type: 'punctuation', value: punctuation });
    index += punctuation.length;
  }
  return tokens;
}

function parseGenerateHandlerCommands(source) {
  const tokens = tokenizeRust(source);
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

function rustFunctionTokens(source, name) {
  const tokens = tokenizeRust(source);
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

function findTokenSequence(tokens, expected, label) {
  const values = tokens.map(token => token.value);
  for (let index = 0; index <= values.length - expected.length; index += 1) {
    if (expected.every((value, offset) => values[index + offset] === value)) return index;
  }
  assert.fail(`${label} token sequence is missing: ${expected.join(' ')}`);
}

function parseCargoSections(source) {
  const sections = new Map();
  let current = '';
  sections.set(current, new Map());
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const section = /^\[([^\]]+)\]$/u.exec(line);
    if (section) {
      current = section[1];
      sections.set(current, new Map());
      continue;
    }
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (entry) sections.get(current).set(entry[1], entry[2]);
  }
  return sections;
}

test('Tauri configuration fixes the product identity, renderer boundary, and window geometry', async () => {
  const config = JSON.parse(await readFile(join(TAURI_DIR, 'tauri.conf.json'), 'utf8'));

  assert.equal(config.productName, 'Ineed MQTT Tool');
  assert.equal(config.identifier, 'com.ineedfull.mqtt-tool');
  assert.equal(config.version, productVersion);
  assert.equal(config.build.frontendDist, '../dist');
  assert.equal(config.app.withGlobalTauri, false);
  assert.equal(config.app.security.csp, null);
  assert.deepEqual(config.app.windows, [{
    backgroundThrottling: 'disabled',
    height: 860,
    label: 'main',
    minHeight: 720,
    minWidth: 1120,
    title: 'iNeed MQTT Tool',
    width: 1360,
  }]);
  assert.equal(config.bundle.active, true);
  assert.equal(config.bundle.targets, 'all');
  assert.deepEqual(config.bundle.icon, BUNDLE_ICONS.map(name => `icons/${name}`));
});

test('default capability grants only core and renderer clipboard text access', async () => {
  const capability = JSON.parse(
    await readFile(join(TAURI_DIR, 'capabilities', 'default.json'), 'utf8'),
  );

  assert.equal(capability.identifier, 'default');
  assert.deepEqual(capability.windows, ['main', 'history-messages', 'history-logs']);
  assert.deepEqual([...capability.permissions].sort(), [
    'clipboard-manager:allow-read-text',
    'clipboard-manager:allow-write-text',
    'core:default',
  ]);
  for (const permission of capability.permissions) {
    assert.equal(permission.includes('*'), false, `wildcard capability: ${permission}`);
    assert.doesNotMatch(permission, /(?:shell|process|filesystem|fs:|opener)/iu);
  }
});

test('Rust package, launcher, build script, and icons form a self-contained Tauri crate', async () => {
  const [manifestSource, mainSource, buildSource] = await Promise.all([
    readFile(join(TAURI_DIR, 'Cargo.toml'), 'utf8'),
    readSource('main.rs'),
    readFile(join(TAURI_DIR, 'build.rs'), 'utf8'),
  ]);
  const manifest = parseCargoSections(manifestSource);

  assert.equal(manifest.get('package').get('name'), '"ineed-mqtt-tool"');
  assert.equal(manifest.get('package').get('version'), JSON.stringify(productVersion));
  assert.equal(manifest.get('package').get('edition'), '"2021"');
  assert.equal(manifest.get('package').get('default-run'), '"ineed-mqtt-tool"');
  assert.equal(manifest.get('lib').get('name'), '"ineed_mqtt_tool_lib"');
  assert.equal(manifest.get('lib').get('crate-type'), '["staticlib", "cdylib", "rlib"]');
  assert.match(mainSource, /^fn main\(\)\s*\{\s*ineed_mqtt_tool_lib::run\(\)\s*\}/su);
  assert.match(buildSource, /println!\("cargo:rerun-if-changed=\{icon\}"\)/u);
  assert.match(buildSource, /tauri_build::build\(\)/u);

  for (const icon of REQUIRED_ICONS) {
    assert.match(buildSource, new RegExp(`"icons/${icon.replaceAll('.', '\\.')}"`, 'u'));
    const iconStat = await stat(join(TAURI_DIR, 'icons', icon));
    assert.equal(iconStat.isFile(), true, icon);
    assert.ok(iconStat.size > 0, `${icon} must not be empty`);
  }
});

test('native facade registers exactly the 35 unified commands', async () => {
  const commands = parseGenerateHandlerCommands(await readSource('lib.rs'));

  assert.equal(commands.length, 35);
  assert.deepEqual([...commands].sort(), EXPECTED_COMMANDS);
  assert.equal(new Set(commands).size, commands.length);
});

test('setup owns the app-data database and managed database and MQTT services', async () => {
  const source = await readSource('lib.rs');

  assert.match(source, /app\.path\(\)\.app_data_dir\(\)\?/u);
  assert.match(source, /create_dir_all\(&app_data_dir\)\?/u);
  assert.match(source, /Database::open\(app_data_dir\.join\(DATABASE_FILENAME\)\)/u);
  assert.match(source, /app\.manage\(database\)/u);
  assert.match(source, /app\.manage\(mqtt_service\)/u);
  assert.doesNotMatch(source, /current_dir|temp_dir|\.\.\/|target\//u);
});

test('main-window close uses an exactly-once request ledger and a bounded fallback', async () => {
  const [boundarySource, libSource, lifecycleSource] = await Promise.all([
    readSource('boundary.rs'),
    readSource('lib.rs'),
    readSource('lifecycle.rs'),
  ]);

  assert.match(libSource, /WindowEvent::CloseRequested/u);
  assert.match(libSource, /request_main_close/u);
  assert.match(lifecycleSource, /api\.prevent_close\(\)/u);
  assert.match(lifecycleSource, /Uuid::new_v4\(\)/u);
  assert.match(lifecycleSource, /window\.emit\("app:before-close"/u);
  assert.match(lifecycleSource, /Duration::from_secs\(15\)/u);
  assert.match(boundarySource, /HashMap<String,\s*String>/u);
  assert.match(boundarySource, /shutting_down:\s*bool/u);
  assert.match(boundarySource, /fn settle\([^)]*request_id/u);
  assert.match(lifecycleSource, /pub async fn window_close_ready/u);
  assert.match(lifecycleSource, /request_id:\s*String/u);
  assert.match(lifecycleSource, /ok:\s*bool/u);
  assert.match(lifecycleSource, /error:\s*Option<String>/u);
  assert.doesNotMatch(lifecycleSource, /get_webview_window\(&request_id\)/u);

  const shutdownTokens = rustFunctionTokens(lifecycleSource, 'shutdown_all_windows');
  const allWindowsIndex = findTokenSequence(
    shutdownTokens,
    ['app', '.', 'webview_windows', '(', ')'],
    'shutdown all-window snapshot',
  );
  const loopIndex = shutdownTokens.findIndex(token => token.value === 'for');
  const destroyIndex = findTokenSequence(
    shutdownTokens,
    ['window', '.', 'destroy', '(', ')'],
    'isolated window destroy',
  );
  const logIndex = findTokenSequence(
    shutdownTokens,
    ['eprintln', '!'],
    'per-window destroy error log',
  );
  const collectErrorIndex = findTokenSequence(
    shutdownTokens,
    ['errors', '.', 'push', '('],
    'destroy error collection',
  );
  const exitIndex = findTokenSequence(
    shutdownTokens,
    ['app', '.', 'exit', '(', '0', ')'],
    'final app exit',
  );
  assert.ok(allWindowsIndex < loopIndex);
  assert.ok(loopIndex < destroyIndex);
  assert.ok(destroyIndex < logIndex && logIndex < collectErrorIndex);
  assert.ok(collectErrorIndex < exitIndex);
  assert.equal(
    shutdownTokens.slice(loopIndex, exitIndex).some(token => token.value === 'return'),
    false,
    'one destroy failure must not skip later windows or app exit',
  );

  const ackTokens = rustFunctionTokens(lifecycleSource, 'window_close_ready');
  const ackSettleIndex = findTokenSequence(
    ackTokens,
    ['state', '.', 'settle', '(', '&', 'request_id', ')'],
    'ACK ledger settlement',
  );
  const ackShutdownIndex = findTokenSequence(
    ackTokens,
    ['shutdown_all_windows', '(', '&', 'app', ')'],
    'ACK centralized shutdown',
  );
  assert.ok(ackSettleIndex < ackShutdownIndex);

  const closeTokens = rustFunctionTokens(lifecycleSource, 'request_main_close');
  const labelGuardIndex = findTokenSequence(
    closeTokens,
    ['window', '.', 'label', '(', ')', '!', '=', 'MAIN_WINDOW_LABEL'],
    'main-only close guard',
  );
  const preventIndex = findTokenSequence(
    closeTokens,
    ['api', '.', 'prevent_close', '(', ')'],
    'main close prevention',
  );
  assert.ok(labelGuardIndex < preventIndex);
  const beginIndex = findTokenSequence(
    closeTokens,
    ['handshake', '.', 'begin', '(', 'window', '.', 'label', '(', ')', ')'],
    'atomic close begin',
  );
  const shutdownPassThroughIndex = findTokenSequence(
    closeTokens,
    ['CloseStart', '::', 'ShuttingDown', '=', '>', 'return'],
    'shutdown CloseRequested pass-through',
  );
  assert.ok(beginIndex < shutdownPassThroughIndex);
  assert.ok(shutdownPassThroughIndex < preventIndex);
  assert.equal(closeTokens.filter(token => token.value === 'settle').length, 2);
  assert.equal(closeTokens.filter(token => token.value === 'shutdown_all_windows').length, 2);

  assert.match(boundarySource, /assert!\(!is_success_status\(302\)\)/u);
  assert.match(boundarySource, /assert_eq!\(ledger\.settle\(&request_id\)/u);
});

test('history windows validate input, encode navigation, and reuse one window per kind', async () => {
  const source = await readSource('window.rs');

  assert.match(source, /match kind\s*\{[\s\S]*"messages"[\s\S]*"logs"[\s\S]*Err/um);
  assert.match(source, /const MAX_CONNECTION_ID_(?:BYTES|LEN):\s*usize\s*=\s*256/u);
  assert.match(source, /conn_id\.is_empty\(\)/u);
  assert.match(source, /form_urlencoded::Serializer/u);
  assert.match(source, /get_webview_window\(&label\)/u);
  assert.match(source, /window\.navigate\(/u);
  assert.match(source, /window\.set_focus\(\)/u);
  assert.match(source, /on_navigation/u);
  assert.match(source, /cfg!\(debug_assertions\)[\s\S]*Some\("localhost"\)[\s\S]*Some\(5175\)/um);
  assert.doesNotMatch(source, /if kind == "logs"\s*\{\s*"logs"\s*\}\s*else\s*\{\s*"messages"/u);
});

test('external URL command is custom Rust code with a narrow HTTPS-only validator', async () => {
  const source = await readSource('window.rs');

  assert.match(source, /pub (?:async )?fn window_open_external/u);
  assert.match(source, /const MAX_EXTERNAL_URL_(?:BYTES|LEN):\s*usize\s*=\s*2048/u);
  assert.match(source, /Url::parse/u);
  assert.match(source, /scheme\(\)\s*!=\s*"https"/u);
  assert.match(source, /username\(\)\.is_empty\(\)/u);
  assert.match(source, /password\(\)\.is_some\(\)/u);
  assert.match(source, /is_control\(\)/u);
  assert.match(source, /open::that/u);
});

test('update command performs one strict, bounded HTTPS request and returns shared fields', async () => {
  const [boundarySource, source] = await Promise.all([
    readSource('boundary.rs'),
    readSource('update.rs'),
  ]);

  assert.match(source, /mqtt\.ineedfull\.com\/updates\/latest\.json/u);
  assert.match(source, /const UPDATE_TIMEOUT:\s*Duration\s*=\s*Duration::from_secs\(10\)/u);
  assert.match(source, /const UPDATE_RESPONSE_MAX_BYTES:\s*usize\s*=\s*65_536/u);
  assert.match(source, /\.get\(UPDATE_ENDPOINT\)/u);
  assert.match(source, /app_id\s*!=\s*"ineed-mqtt-tool"/u);
  assert.match(source, /schema_version\s*!=\s*1/u);
  assert.match(source, /tauri-\{platform\}-\{arch\}-\{format\}/u);
  assert.match(source, /content_length\(\)/u);
  assert.match(source, /response\.chunk\(\)\.await/u);
  assert.match(source, /redirect\(reqwest::redirect::Policy::none\(\)\)/u);
  assert.match(source, /serde_json::from_slice/u);
  assert.match(source, /validate_external_url/u);
  assert.match(source, /pub async fn update_check/u);
  assert.match(boundarySource, /pub\(crate\) fn is_success_status\(status:\s*u16\)/u);
  const updateTokens = rustFunctionTokens(source, 'update_check');
  const statusIndex = findTokenSequence(
    updateTokens,
    ['response', '.', 'status', '(', ')'],
    'HTTP status capture',
  );
  const rejectIndex = findTokenSequence(
    updateTokens,
    ['if', '!', 'is_success_status', '(', 'status', '.', 'as_u16', '(', ')', ')'],
    'explicit non-2xx rejection',
  );
  const contentLengthIndex = findTokenSequence(
    updateTokens,
    ['response', '.', 'content_length', '(', ')'],
    'Content-Length read',
  );
  const chunkIndex = findTokenSequence(
    updateTokens,
    ['response', '.', 'chunk', '(', ')'],
    'response body read',
  );
  assert.ok(statusIndex < rejectIndex);
  assert.ok(rejectIndex < contentLengthIndex);
  assert.ok(contentLengthIndex < chunkIndex);
  for (const field of ['available', 'version', 'url', 'force', 'description']) {
    assert.match(source, new RegExp(`pub\\s+${field}:`), field);
  }
});
