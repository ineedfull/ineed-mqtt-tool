import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));
const fixturesDirectory = join(packageDirectory, 'fixtures');
const expectedPath = join(fixturesDirectory, 'expected-records.json');
const manifestPath = join(repositoryDirectory, 'apps/tauri/src-tauri/Cargo.toml');
const databaseModulePath = join(repositoryDirectory, 'apps/electron/electron/database.cjs');
const harnessSourcePath = join(
  repositoryDirectory,
  'apps/tauri/src-tauri/src/bin/database_compat_harness.rs',
);
const fixtureNames = ['electron-current.db', 'tauri-current.db'];
const temporaryDirectories = new Set();
let expected;
let harnessExecutable;

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  return value && typeof value === 'object' ? { ...value } : value;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function sourceFingerprint(path) {
  const [hash, metadata] = await Promise.all([sha256(path), stat(path, { bigint: true })]);
  return {
    hash,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs,
  };
}

async function copyFixture(fixtureName, label = 'snapshot') {
  const directory = await mkdtemp(join(tmpdir(), `ineed-db-compat-${label}-`));
  temporaryDirectories.add(directory);
  const databasePath = join(directory, `${label}-${fixtureName}`);
  await copyFile(join(fixturesDirectory, fixtureName), databasePath);
  assert.equal(isAbsolute(databasePath), true);
  return databasePath;
}

function normalizedStorage(stats) {
  return {
    messageCount: Number(stats.messageCount),
    logCount: Number(stats.logCount),
    publishCount: Number(stats.publishCount),
    totalCount: Number(stats.totalCount),
  };
}

function electronCompatibilityChecks(databasePath) {
  const directory = mkdtempSync(join(tmpdir(), 'ineed-db-compat-electron-checks-'));
  const behaviorPath = join(directory, 'behavior-electron-current.db');
  copyFileSync(databasePath, behaviorPath);
  const { createDatabase } = require(databaseModulePath);
  const database = createDatabase(behaviorPath);
  try {
    database.saveMessages(Array.from({ length: 21 }, (_, index) => ({
      connection_id: 'compat-connection',
      topic: `devices/compat/page-${String(index + 1).padStart(2, '0')}`,
      payload: `compat needle ${index + 1}`,
      direction: 'out',
      qos: index % 3,
      retained: index % 2,
      format: 'text',
    })));
    const messages = database.queryHistoryMessages({
      connId: 'compat-connection', direction: 'out', keyword: 'compat needle',
      page: 2, pageSize: 20,
    });
    const logs = database.queryHistoryLogs({
      connId: 'compat-connection', level: 'info', keyword: 'compat fixture',
      page: 1, pageSize: 20,
    });
    database.saveSetting('theme', 'light');
    const setting = database.getSetting('theme');
    database.deleteConnection('compat-connection');
    return {
      filteredMessages: {
        topics: messages.rows.map(row => row.topic),
        total: messages.total,
        page: messages.page,
        pageSize: messages.pageSize,
      },
      filteredLogs: { messages: logs.rows.map(row => row.msg), total: logs.total },
      setting,
      cascade: {
        connections: database.getConnections().length,
        subscriptions: database.getSubscriptions('compat-connection').length,
        messages: database.queryHistoryMessages({ connId: 'compat-connection' }).total,
        publishHistory: database.getPublishHistory('compat-connection', 100).length,
        logs: database.queryHistoryLogs({ connId: 'compat-connection' }).total,
        theme: database.getSetting('theme'),
      },
    };
  } finally {
    database.closeDatabase();
    rmSync(directory, { force: true, recursive: true });
  }
}

function electronSnapshot(databasePath) {
  const { createDatabase } = require(databaseModulePath);
  const database = createDatabase(databasePath);
  try {
    const snapshot = {
      connections: plain(database.getConnections()),
      subscriptions: plain(database.getSubscriptions('compat-connection')),
      messageCounts: plain(database.getMessageCounts()),
      messages: plain(database.queryHistoryMessages({
        connId: 'compat-connection', page: 1, pageSize: 100,
      }).rows),
      logs: plain(database.queryHistoryLogs({
        connId: 'compat-connection', page: 1, pageSize: 100,
      }).rows),
      publishHistory: plain(database.getPublishHistory('compat-connection', 100)),
      settings: database.getAllSettings(),
      storage: normalizedStorage(database.getStorageStats()),
    };
    const userVersion = database.getConnectionPragmas().userVersion;
    database.closeDatabase();
    return {
      ...snapshot,
      compatibilityChecks: electronCompatibilityChecks(databasePath),
      userVersion,
    };
  } finally {
    database.closeDatabase();
  }
}

function rustSnapshot(databasePath) {
  const result = runRustHarness(databasePath);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  return JSON.parse(result.stdout);
}

function runRustHarness(databasePath) {
  return spawnSync(harnessExecutable, [databasePath], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function cargoHarnessExecutable() {
  const result = spawnSync('cargo', [
    'build', '--locked', '--manifest-path', manifestPath,
    '--bin', 'database_compat_harness', '--message-format=json-render-diagnostics',
  ], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const artifacts = result.stdout.trim().split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact'
      && message.target?.name === 'database_compat_harness'
      && message.executable);
  assert.equal(artifacts.length > 0, true, 'Cargo did not report the harness executable');
  return artifacts.at(-1).executable;
}

function spawnFixtureGenerator(scriptPath, outputDirectory, env = {}) {
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', scriptPath,
    '--output-dir', outputDirectory,
  ], {
    cwd: packageDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function runFixtureGenerator(scriptPath, outputDirectory) {
  const result = spawnFixtureGenerator(scriptPath, outputDirectory);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function tableRows(database, table) {
  const primaryKey = database.prepare(`PRAGMA table_xinfo(${table})`).all()
    .filter(column => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(column => column.name);
  const orderBy = primaryKey.length > 0 ? ` ORDER BY ${primaryKey.join(', ')}` : '';
  return database.prepare(`SELECT * FROM ${table}${orderBy}`).all().map(plain);
}

function fixtureSemantics(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = [
      'connections', 'subscriptions', 'message_history',
      'publish_history', 'settings', 'logs',
    ];
    return {
      userVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
      foreignKeys: Object.fromEntries(tables.map(table => [
        table, database.prepare(`PRAGMA foreign_key_list(${table})`).all().map(plain),
      ])),
      columns: Object.fromEntries(tables.map(table => [
        table, database.prepare(`PRAGMA table_xinfo(${table})`).all().map(plain),
      ])),
      indexes: database.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE type = 'index' AND sql IS NOT NULL ORDER BY name
      `).all().map(plain),
      rows: Object.fromEntries(tables.map(table => [table, tableRows(database, table)])),
      integrity: database.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all().map(plain),
    };
  } finally {
    database.close();
  }
}

before(async () => {
  assert.equal(Number(process.versions.node.split('.')[0]) >= 22, true, 'Node 22+ is required');
  expected = JSON.parse(await readFile(expectedPath, 'utf8'));
  for (const fixtureName of fixtureNames) {
    const info = await stat(join(fixturesDirectory, fixtureName));
    assert.equal(info.isFile(), true);
  }
  const harnessInfo = await stat(harnessSourcePath);
  assert.equal(harnessInfo.isFile(), true);
  harnessExecutable = cargoHarnessExecutable();
});

after(async () => {
  await Promise.all([...temporaryDirectories].map(directory => (
    rm(directory, { force: true, recursive: true })
  )));
});

describe('legacy database reader matrix', () => {
  for (const fixtureName of fixtureNames) {
    for (const reader of ['electron', 'rust']) {
      test(`${basename(fixtureName)} opens twice through the ${reader} production reader`, async () => {
        const sourcePath = join(fixturesDirectory, fixtureName);
        const sourceHash = await sha256(sourcePath);
        const databasePath = await copyFixture(fixtureName, `${reader}-matrix`);
        const readSnapshot = reader === 'electron' ? electronSnapshot : rustSnapshot;

        assert.deepEqual(readSnapshot(databasePath), expected);
        assert.deepEqual(readSnapshot(databasePath), expected);
        assert.equal(await sha256(sourcePath), sourceHash, 'source fixture changed');
      });
    }
  }
});

test('fixtures retain their explicit legacy versions, columns, and safe fixed rows', () => {
  const expectedLegacy = {
    'electron-current.db': {
      userVersion: 0,
      subscriptions: ['id', 'connection_id', 'topic', 'qos', 'status', 'created_at'],
      messageHistory: [
        'id', 'connection_id', 'topic', 'payload', 'direction', 'qos', 'retained', 'created_at',
      ],
    },
    'tauri-current.db': {
      userVersion: 0,
      subscriptions: [
        'id', 'connection_id', 'topic', 'qos', 'status', 'color', 'format', 'created_at',
      ],
      messageHistory: [
        'id', 'connection_id', 'topic', 'payload', 'direction', 'qos', 'retained', 'created_at',
      ],
    },
  };
  for (const fixtureName of fixtureNames) {
    const database = new DatabaseSync(join(fixturesDirectory, fixtureName), { readOnly: true });
    try {
      const columns = table => database.prepare(`PRAGMA table_xinfo(${table})`).all()
        .map(column => column.name);
      assert.equal(
        Number(database.prepare('PRAGMA user_version').get().user_version),
        expectedLegacy[fixtureName].userVersion,
      );
      assert.deepEqual(columns('subscriptions'), expectedLegacy[fixtureName].subscriptions);
      assert.deepEqual(columns('message_history'), expectedLegacy[fixtureName].messageHistory);
      for (const table of [
        'connections', 'subscriptions', 'message_history',
        'publish_history', 'settings', 'logs',
      ]) {
        assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) > 0, true);
      }
      const connection = { ...database.prepare(
        'SELECT id, host, username, password FROM connections',
      ).get() };
      assert.deepEqual(connection, {
        id: 'compat-connection',
        host: 'example.invalid',
        username: 'fixture-user',
        password: 'fixture-only-not-a-secret',
      });
    } finally {
      database.close();
    }
  }
});

test('Electron repairs a synthetic version 1 database missing an additive column', async () => {
  const databasePath = await copyFixture('tauri-current.db', 'synthetic-version-one');
  const inspector = new DatabaseSync(databasePath);
  inspector.exec('PRAGMA user_version = 1');
  inspector.close();

  const { createDatabase } = require(databaseModulePath);
  const database = createDatabase(databasePath);
  try {
    assert.equal(database.getConnectionPragmas().userVersion, 1);
    assert.deepEqual(database.queryHistoryMessages({ connId: 'compat-connection' }).rows
      .map(row => row.format), ['', '']);
  } finally {
    database.closeDatabase();
  }
});

test('Electron production queries preserve paging, filtering, settings, and cascade behavior', async () => {
  const databasePath = await copyFixture('electron-current.db', 'electron-behavior');
  const { createDatabase } = require(databaseModulePath);
  const database = createDatabase(databasePath);
  try {
    database.saveMessages(Array.from({ length: 21 }, (_, index) => ({
      connection_id: 'compat-connection',
      topic: `devices/compat/page-${String(index + 1).padStart(2, '0')}`,
      payload: `compat needle ${index + 1}`,
      direction: 'out',
      qos: index % 3,
      retained: index % 2,
      format: 'text',
    })));
    const page = database.queryHistoryMessages({
      connId: 'compat-connection', direction: 'out', keyword: 'compat needle',
      page: 2, pageSize: 20,
    });
    assert.deepEqual({
      topics: page.rows.map(row => row.topic),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    }, {
      topics: ['devices/compat/page-01'], total: 21, page: 2, pageSize: 20,
    });
    assert.equal(database.getSetting('theme'), 'dark');
    database.saveSetting('theme', 'light');
    assert.equal(database.getSetting('theme'), 'light');

    database.deleteConnection('compat-connection');
    assert.deepEqual(database.getConnections(), []);
    assert.deepEqual(database.getSubscriptions('compat-connection'), []);
    assert.equal(database.queryHistoryMessages({ connId: 'compat-connection' }).total, 0);
    assert.deepEqual(database.getPublishHistory('compat-connection', 100), []);
    assert.equal(
      database.queryHistoryLogs({ connId: 'compat-connection' }).total,
      1,
      'legacy logs intentionally do not have a foreign key',
    );
  } finally {
    database.closeDatabase();
  }
});

test('Rust harness rejects paths that could target a live profile', async () => {
  const databasePath = await copyFixture('tauri-current.db', 'guard');
  const cases = [
    { args: [], pattern: /exactly one/ },
    { args: ['relative.db'], pattern: /absolute/ },
    { args: [databasePath, databasePath], pattern: /exactly one/ },
    { args: [join(tmpdir(), 'ineed-mqtt.db')], pattern: /live database filename/ },
    { args: [join(tmpdir(), 'missing-compat.db')], pattern: /regular file/ },
  ];
  for (const testCase of cases) {
    const result = spawnSync(harnessExecutable, testCase.args, { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, testCase.pattern);
  }
});

for (const sourceKind of ['hardlink', 'symlink', 'read-only']) {
  test(`Rust harness reads a ${sourceKind} source without changing its inode`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `ineed-db-compat-${sourceKind}-`));
    temporaryDirectories.add(directory);
    const sourcePath = join(directory, 'source-tauri-current.db');
    const inputPath = join(directory, `${sourceKind}-tauri-current.db`);
    await copyFile(join(fixturesDirectory, 'tauri-current.db'), sourcePath);
    if (sourceKind === 'hardlink') await link(sourcePath, inputPath);
    if (sourceKind === 'symlink') await symlink(sourcePath, inputPath);
    if (sourceKind === 'read-only') {
      await chmod(sourcePath, 0o400);
    }
    const harnessPath = sourceKind === 'read-only' ? sourcePath : inputPath;
    const before = await sourceFingerprint(sourcePath);
    const result = runRustHarness(harnessPath);
    const after = await sourceFingerprint(sourcePath);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.deepEqual(after, before);
  });
}

test('Rust harness rejects a symlink alias to a directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-db-compat-directory-alias-'));
  temporaryDirectories.add(directory);
  const sourceDirectory = join(directory, 'source-directory');
  const aliasPath = join(directory, 'directory-alias.db');
  await mkdir(sourceDirectory);
  await symlink(sourceDirectory, aliasPath, 'dir');
  const result = runRustHarness(aliasPath);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /regular file/);
});

test('fixture generator is same-runtime deterministic without rewriting committed fixtures', async () => {
  const scriptPath = join(packageDirectory, 'scripts/create-database-fixtures.mjs');
  const firstDirectory = await mkdtemp(join(tmpdir(), 'ineed-db-compat-generator-first-'));
  const secondDirectory = await mkdtemp(join(tmpdir(), 'ineed-db-compat-generator-second-'));
  temporaryDirectories.add(firstDirectory);
  temporaryDirectories.add(secondDirectory);
  const committedHashes = await Promise.all(fixtureNames.map(name => sha256(join(fixturesDirectory, name))));
  const firstOutput = runFixtureGenerator(scriptPath, firstDirectory);
  const firstHashes = await Promise.all(fixtureNames.map(name => sha256(join(firstDirectory, name))));
  const secondOutput = runFixtureGenerator(scriptPath, secondDirectory);
  const secondHashes = await Promise.all(fixtureNames.map(name => sha256(join(secondDirectory, name))));
  assert.equal(firstOutput, secondOutput);
  assert.deepEqual(firstHashes, secondHashes);
  assert.deepEqual(
    await Promise.all(fixtureNames.map(name => sha256(join(fixturesDirectory, name)))),
    committedHashes,
  );
  const sqlite = new DatabaseSync(':memory:');
  const sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS version').get().version;
  sqlite.close();
  assert.match(firstOutput, new RegExp(`^runtime node=${process.versions.node} sqlite=${sqliteVersion}\\n`));
  assert.equal(firstOutput.includes('fixture-only-not-a-secret'), false);
  assert.deepEqual((await readdir(firstDirectory)).toSorted(), fixtureNames.toSorted());
  assert.deepEqual((await readdir(secondDirectory)).toSorted(), fixtureNames.toSorted());
  for (const fixtureName of fixtureNames) {
    assert.deepEqual(
      fixtureSemantics(join(firstDirectory, fixtureName)),
      fixtureSemantics(join(fixturesDirectory, fixtureName)),
    );
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await assert.rejects(stat(join(firstDirectory, `${fixtureName}${suffix}`)), { code: 'ENOENT' });
    }
  }
});

test('fixture generator failure preserves existing targets and removes private artifacts', async () => {
  const scriptPath = join(packageDirectory, 'scripts/create-database-fixtures.mjs');
  const outputDirectory = await mkdtemp(join(tmpdir(), 'ineed-db-compat-generator-failure-'));
  temporaryDirectories.add(outputDirectory);
  const targetPath = join(outputDirectory, 'electron-current.db');
  const sentinel = 'preserve-existing-target';
  await writeFile(targetPath, sentinel);

  const result = spawnFixtureGenerator(scriptPath, outputDirectory, {
    INEED_DATABASE_FIXTURE_FAIL_BEFORE_RENAME: 'electron-current.db',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /injected fixture generation failure/);
  assert.equal(await readFile(targetPath, 'utf8'), sentinel);
  assert.deepEqual(await readdir(outputDirectory), ['electron-current.db']);
});

test('fixture generator rejects a relative output directory and avoids Object.values bindings', async () => {
  const scriptPath = join(packageDirectory, 'scripts/create-database-fixtures.mjs');
  const result = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', scriptPath,
    '--output-dir', 'relative-fixtures',
  ], { cwd: packageDirectory, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /absolute/);
  assert.equal((await readFile(scriptPath, 'utf8')).includes('Object.values'), false);
});
