import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const databaseModulePath = fileURLToPath(new URL('../electron/database.cjs', import.meta.url));
const sqliteSemanticsPath = fileURLToPath(
  new URL('../electron/sqliteSemantics.cjs', import.meta.url),
);
const fixturePath = fileURLToPath(new URL('./fixtures/current-electron.db', import.meta.url));
const fixtureGeneratorPath = fileURLToPath(
  new URL('./fixtures/generateCurrentElectronFixture.cjs', import.meta.url),
);
const PRELOAD_DATABASE_METHODS = Object.freeze([
  'getConnections',
  'saveConnection',
  'deleteConnection',
  'getMessageCounts',
  'getSubscriptions',
  'addSubscription',
  'removeSubscription',
  'saveMessages',
  'saveLogs',
  'queryHistoryMessages',
  'deleteHistoryMessage',
  'clearHistoryMessages',
  'queryHistoryLogs',
  'deleteHistoryLog',
  'clearHistoryLogs',
  'getPublishHistory',
  'savePublish',
  'getAllSettings',
  'saveSetting',
  'getStorageStats',
  'clearHistoryStorage',
]);

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  return value && typeof value === 'object' ? { ...value } : value;
}

async function openFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-db-'));
  let api = null;
  let closed = false;
  t.after(async () => {
    if (api && !closed) api.closeDatabase();
    await rm(directory, { force: true, recursive: true });
  });
  const databasePath = join(directory, 'current-electron.db');
  await copyFile(fixturePath, databasePath);

  const { createDatabase } = require(databaseModulePath);
  api = createDatabase(databasePath);

  return {
    api,
    close() {
      if (closed) return;
      closed = true;
      api.closeDatabase();
    },
    databasePath,
    directory,
  };
}

async function createMalformedSchema(t, userVersion) {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-malformed-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'malformed.db');
  let schemaSql = await readFile(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql'),
    'utf8',
  );
  const replacements = [
    ['host TEXT NOT NULL', 'host BLOB NOT NULL'],
    ['port INTEGER DEFAULT 1883', 'port INTEGER DEFAULT 9999'],
    ['connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE', 'connection_id TEXT'],
    ["direction TEXT CHECK (direction IN ('in', 'out'))", 'direction TEXT'],
  ];
  for (const [expected, replacement] of replacements) {
    assert.equal(schemaSql.includes(expected), true, `shared schema contains ${expected}`);
    schemaSql = schemaSql.replaceAll(expected, replacement);
  }
  const database = new DatabaseSync(databasePath);
  database.exec(schemaSql);
  database.exec(`
    DROP INDEX idx_message_history_conn_time_id;
    DROP INDEX idx_logs_conn_time_id;
    PRAGMA user_version = ${userVersion};
  `);
  database.close();
  return databasePath;
}

async function createAdditiveLegacySchema(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-legacy-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'legacy.db');
  let schemaSql = await readFile(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql'),
    'utf8',
  );
  for (const columns of [
    "  color TEXT DEFAULT '',\n  format TEXT DEFAULT 'json',\n",
    "  format TEXT DEFAULT '',\n",
  ]) {
    assert.equal(schemaSql.includes(columns), true, `shared schema contains ${columns.trim()}`);
    schemaSql = schemaSql.replace(columns, '');
  }

  const database = new DatabaseSync(databasePath);
  database.exec(schemaSql);
  database.exec(`
    INSERT INTO connections (id, name, host) VALUES ('legacy', 'Legacy', 'localhost');
    INSERT INTO subscriptions (id, connection_id, topic)
      VALUES ('legacy-sub', 'legacy', 'legacy/#');
    INSERT INTO message_history (connection_id, topic, direction)
      VALUES ('legacy', 'legacy/topic', 'in');
    PRAGMA user_version = 0;
  `);
  database.close();
  return databasePath;
}

async function createCheckSchema(t, replacement) {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-check-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'check.db');
  let schemaSql = await readFile(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql'),
    'utf8',
  );
  const canonical = "direction TEXT CHECK (direction IN ('in', 'out'))";
  assert.equal(schemaSql.includes(canonical), true, 'shared schema contains direction CHECK');
  schemaSql = schemaSql.replace(canonical, replacement);

  const database = new DatabaseSync(databasePath);
  database.exec(schemaSql);
  database.exec('PRAGMA user_version = 1');
  database.close();
  return databasePath;
}

async function createExtendedSchema(t, { transform = sql => sql, extension = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-extension-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'extension.db');
  const canonicalSql = await readFile(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql'),
    'utf8',
  );
  const database = new DatabaseSync(databasePath);
  database.exec(transform(canonicalSql));
  if (extension) database.exec(extension);
  database.exec('PRAGMA user_version = 1');
  database.close();
  return databasePath;
}

test('opens a current Electron database without replacing its representative rows', async (t) => {
  const { api, databasePath } = await openFixture(t);

  assert.equal(Object.isFrozen(api), true);
  assert.equal(typeof api.closeDatabase, 'function');
  for (const method of PRELOAD_DATABASE_METHODS) assert.equal(typeof api[method], 'function', method);
  assert.deepEqual(plain(api.getConnections()), [{
    id: 'conn-fixture',
    name: 'Fixture broker',
    host: 'fixture.example',
    port: 8883,
    protocol: 'mqtts',
    path: '/mqtt',
    client_id: 'fixture-client',
    username: 'fixture-user',
    password: 'fixture-password',
    ssl: 1,
    keepalive: 45,
    clean_session: 0,
    sort_order: 7,
    created_at: '2025-01-02 03:04:05.006',
    updated_at: '2025-01-02 03:04:06.007',
  }]);
  assert.deepEqual(plain(api.getSubscriptions('conn-fixture')), [{
    id: 'sub-fixture',
    connection_id: 'conn-fixture',
    topic: 'fixture/#',
    qos: 2,
    status: 'pending',
    color: '#123456',
    format: 'hex',
    created_at: '2025-01-02 03:05:00.000',
  }]);
  assert.deepEqual(plain(api.getMessageCounts()), [{
    connection_id: 'conn-fixture',
    messages_in: 1,
    messages_out: 0,
  }]);
  assert.deepEqual(api.getAllSettings(), { theme: 'dark' });
  assert.equal(api.getSetting('theme'), 'dark');
  assert.deepEqual(plain(api.getPublishHistory('conn-fixture', 10)), [{
    id: 201,
    connection_id: 'conn-fixture',
    topic: 'fixture/publish',
    payload: 'published payload',
    qos: 1,
    retained: 1,
    created_at: '2025-01-02 03:07:00.000',
  }]);
  const stats = api.getStorageStats();
  assert.deepEqual({
    messageCount: stats.messageCount,
    logCount: stats.logCount,
    publishCount: stats.publishCount,
    totalCount: stats.totalCount,
  }, { messageCount: 1, logCount: 1, publishCount: 1, totalCount: 3 });
  for (const key of ['databaseBytes', 'walBytes', 'shmBytes', 'totalBytes']) {
    assert.equal(Number.isSafeInteger(stats[key]), true, key);
    assert.equal(stats[key] >= 0, true, key);
  }
  assert.equal(api.getConnections().some(({ id }) => id.startsWith('conn-emqx-')), false);
  assert.equal(typeof databasePath, 'string');
});

test('queries messages and logs with stable filtered pagination', async (t) => {
  const { api } = await openFixture(t);

  api.saveMessages(Array.from({ length: 21 }, (_, index) => ({
    connection_id: 'conn-fixture',
    topic: `fixture/page-${String(index + 1).padStart(2, '0')}`,
    payload: `needle ${index + 1}`,
    direction: 'out',
    qos: index % 3,
    retained: index % 2,
    format: 'text',
  })));
  api.saveLogs([
    { connId: 'conn-fixture', time: '03:08:00', level: 'warn', msg: 'needle warning' },
    { connId: 'conn-fixture', time: '03:09:00', level: 'info', msg: 'ignored' },
  ]);

  const messages = api.queryHistoryMessages({
    connId: 'conn-fixture', direction: 'out', keyword: 'needle', page: 2, pageSize: 20,
  });
  assert.deepEqual(
    {
      topics: messages.rows.map(({ topic }) => topic),
      total: messages.total,
      page: messages.page,
      pageSize: messages.pageSize,
    },
    { topics: ['fixture/page-01'], total: 21, page: 2, pageSize: 20 },
  );

  const firstPage = api.queryHistoryMessages({
    connId: 'conn-fixture', direction: 'out', keyword: 'needle', page: 1, pageSize: 20,
  });
  assert.equal(firstPage.total, 21);
  assert.equal(firstPage.rows.length, 20);
  assert.deepEqual(
    firstPage.rows.slice(0, 2).map(({ topic }) => topic),
    ['fixture/page-21', 'fixture/page-20'],
  );

  const logs = api.queryHistoryLogs({
    connId: 'conn-fixture', level: 'warn', keyword: 'needle', page: 1, pageSize: 20,
  });
  assert.equal(logs.total, 1);
  assert.equal(logs.rows[0].msg, 'needle warning');
  assert.throws(
    () => api.queryHistoryMessages({ direction: "in' OR 1=1 --" }),
    /direction/,
  );
});

test('updates CRUD state and persists it across close and reopen', async (t) => {
  const fixture = await openFixture(t);
  const { api, databasePath } = fixture;
  const addedSubscription = {
    id: 'sub-added', connection_id: 'conn-fixture', topic: 'added/#', qos: 1,
    status: 'active', color: '#abcdef', format: 'json',
  };

  api.saveConnection({
    id: 'conn-fixture', name: 'Updated broker', host: 'updated.example', port: 1884,
    protocol: 'mqtt', path: '/updated', client_id: 'updated-client', username: 'next-user',
    password: 'next-password', ssl: 0, keepalive: 30, clean_session: 1, sort_order: 2,
  });
  api.addSubscription(addedSubscription);
  api.removeSubscription('sub-added');
  assert.deepEqual(api.getSubscriptions('conn-fixture').map(({ id }) => id), ['sub-fixture']);
  api.addSubscription(addedSubscription);
  api.savePublish({
    connection_id: 'conn-fixture', topic: 'added/publish', payload: 'next', qos: 2, retained: 0,
  });
  api.saveSetting('maxRealtimeMessages', 250);
  fixture.close();

  const { createDatabase } = require(databaseModulePath);
  const reopened = createDatabase(databasePath);
  t.after(() => reopened.closeDatabase());

  assert.equal(reopened.getConnections()[0].name, 'Updated broker');
  assert.equal(reopened.getConnections()[0].path, '/updated');
  assert.match(
    reopened.getConnections()[0].updated_at,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
  );
  assert.deepEqual(
    reopened.getSubscriptions('conn-fixture').map(({ id }) => id).toSorted(),
    ['sub-added', 'sub-fixture'],
  );
  assert.equal(reopened.getPublishHistory('conn-fixture', 1)[0].topic, 'added/publish');
  assert.equal(reopened.getSetting('maxRealtimeMessages'), '250');
});

test('generates distinct connection IDs for saves in the same millisecond', async (t) => {
  const { api } = await openFixture(t);
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  t.after(() => {
    Date.now = originalNow;
  });

  const firstId = api.saveConnection({ name: 'Generated one', host: 'one.example' });
  const secondId = api.saveConnection({ name: 'Generated two', host: 'two.example' });

  assert.notEqual(firstId, secondId);
  assert.match(firstId, /^conn-/);
  assert.match(secondId, /^conn-/);
  assert.deepEqual(
    api.getConnections().filter(({ id }) => id !== 'conn-fixture').map(({ id }) => id).toSorted(),
    [firstId, secondId].toSorted(),
  );
});

test('reapplies the current migration idempotently without losing existing data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-migration-'));
  let second = null;
  t.after(async () => {
    second?.closeDatabase();
    await rm(directory, { force: true, recursive: true });
  });
  const databasePath = join(directory, 'migration.db');
  await copyFile(fixturePath, databasePath);
  const inspector = new DatabaseSync(databasePath);
  inspector.exec('PRAGMA user_version = 0');
  inspector.close();

  const { createDatabase } = require(databaseModulePath);
  const first = createDatabase(databasePath);
  assert.equal(first.getConnectionPragmas().userVersion, 1);
  assert.equal(first.getConnections()[0].id, 'conn-fixture');
  first.closeDatabase();

  second = createDatabase(databasePath);
  assert.equal(second.getConnectionPragmas().userVersion, 1);
  assert.equal(second.queryHistoryMessages({}).total, 1);
});

test('accepts additive legacy columns regardless of their physical table order', async (t) => {
  const databasePath = await createAdditiveLegacySchema(t);
  const { createDatabase } = require(databaseModulePath);

  const api = createDatabase(databasePath);
  t.after(() => api.closeDatabase());
  assert.deepEqual(
    plain(api.getSubscriptions('legacy')).map(({ color, format }) => ({ color, format })),
    [{ color: '', format: 'json' }],
  );
  assert.equal(api.queryHistoryMessages({ connId: 'legacy' }).rows[0].format, '');
  assert.equal(api.getConnectionPragmas().userVersion, 1);
});

test('rejects a version 1 database whose columns hide incompatible schema semantics', async (t) => {
  const databasePath = await createMalformedSchema(t, 1);
  const { createDatabase } = require(databaseModulePath);

  assert.throws(() => {
    const api = createDatabase(databasePath);
    api.closeDatabase();
  }, /schema/i);
});

test('rolls back version 0 migration instead of stamping incompatible schema as current', async (t) => {
  const databasePath = await createMalformedSchema(t, 0);
  const { createDatabase } = require(databaseModulePath);

  assert.throws(() => {
    const api = createDatabase(databasePath);
    api.closeDatabase();
  }, /schema/i);

  const inspector = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(inspector.prepare('PRAGMA user_version').get().user_version, 0);
    assert.deepEqual(inspector.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_%'",
    ).all(), []);
  } finally {
    inspector.close();
  }
});

test('accepts token-equivalent CHECK syntax with nested parentheses and comments', async (t) => {
  const databasePath = await createCheckSchema(
    t,
    `direction TEXT CHECK (
      /* a comment containing a close parenthesis ) */
      (("direction" in ('in', 'out')))
    )`,
  );
  const { createDatabase } = require(databaseModulePath);

  const api = createDatabase(databasePath);
  api.closeDatabase();
});

test('CHECK tokenizer ignores quoted and commented parentheses', () => {
  const { checkConstraintSemantics } = require(sqliteSemanticsPath);
  const expected = checkConstraintSemantics(`
    CREATE TABLE sample (value TEXT CHECK (value <> ')('))
  `);
  for (const equivalent of [
    `CREATE TABLE sample (
      "value" TEXT CHECK ( /* comment ) */ (("value" <> ')(')) )
    )`,
    `CREATE TABLE sample (
      [value] TEXT CHECK (
        -- comment containing both ( and )
        (([value] <> ')('))
      )
    )`,
    "CREATE TABLE sample (`value` TEXT CHECK (`value` <> ')('))",
  ]) {
    assert.deepEqual(checkConstraintSemantics(equivalent), expected);
  }
});

for (const [variant, replacement] of [
  ['missing', 'direction TEXT'],
  ['different', "direction TEXT CHECK (direction <> 'invalid')"],
  [
    'additional',
    `direction TEXT CHECK (direction IN ('in', 'out'))
      CHECK (length(topic) > 0)`,
  ],
]) {
  test(`rejects ${variant} CHECK semantics in an otherwise canonical version 1 database`, async (t) => {
    const databasePath = await createCheckSchema(t, replacement);
    const { createDatabase } = require(databaseModulePath);

    assert.throws(() => {
      const api = createDatabase(databasePath);
      api.closeDatabase();
    }, /CHECK|schema/i);
  });
}

for (const [variant, options] of [
  ['explicit unique index', {
    extension: 'CREATE UNIQUE INDEX extra_unique_message_topic ON message_history (topic)',
  }],
  ['table UNIQUE constraint autoindex', {
    transform(schemaSql) {
      const canonicalEnd = `  format TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);`;
      assert.equal(schemaSql.includes(canonicalEnd), true, 'message_history table ending');
      return schemaSql.replace(canonicalEnd, `  format TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (topic)
);`);
    },
  }],
  ['trigger', {
    extension: `
      CREATE TRIGGER extra_message_topic_normalizer
      AFTER INSERT ON message_history
      BEGIN
        UPDATE message_history SET topic = upper(topic) WHERE id = NEW.id;
      END;
    `,
  }],
]) {
  test(`rejects an otherwise canonical version 1 database with an extra ${variant}`, async (t) => {
    const databasePath = await createExtendedSchema(t, options);
    const { createDatabase } = require(databaseModulePath);

    assert.throws(() => {
      const api = createDatabase(databasePath);
      api.closeDatabase();
    }, /schema/i);
  });
}

test('allows benign extra non-unique performance indexes', async (t) => {
  const databasePath = await createExtendedSchema(t, {
    extension: 'CREATE INDEX extra_message_topic ON message_history (topic)',
  });
  const { createDatabase } = require(databaseModulePath);

  const api = createDatabase(databasePath);
  api.closeDatabase();
});

test('deleting a connection cascades only contract-owned child rows', async (t) => {
  const { api } = await openFixture(t);

  api.deleteConnection('conn-fixture');

  assert.deepEqual(api.getConnections(), []);
  assert.deepEqual(api.getSubscriptions('conn-fixture'), []);
  assert.deepEqual(api.getMessageCounts(), []);
  assert.deepEqual(api.getPublishHistory('conn-fixture', 10), []);
  assert.equal(api.queryHistoryLogs({ connId: 'conn-fixture' }).total, 1);
});

test('history deletion and filtered clearing affect only matching rows', async (t) => {
  const { api } = await openFixture(t);

  api.saveMessages([
    { connection_id: 'conn-fixture', topic: 'keep/topic', payload: 'keep', direction: 'in' },
    { connection_id: 'conn-fixture', topic: 'clear/topic', payload: 'clear', direction: 'out' },
  ]);
  api.saveLogs([
    { connId: 'conn-fixture', time: '03:08:00', level: 'warn', msg: 'clear me' },
    { connId: 'conn-fixture', time: '03:09:00', level: 'info', msg: 'keep me' },
  ]);
  const fixtureMessageId = api.queryHistoryMessages({ topic: 'fixture/topic' }).rows[0].id;
  const fixtureLogId = api.queryHistoryLogs({ keyword: 'fixture log' }).rows[0].id;

  api.deleteHistoryMessage(fixtureMessageId);
  api.deleteHistoryLog(fixtureLogId);
  api.clearHistoryMessages({ connId: 'conn-fixture', direction: 'out', topic: 'clear' });
  api.clearHistoryLogs({ connId: 'conn-fixture', level: 'warn', keyword: 'clear' });

  assert.deepEqual(api.queryHistoryMessages({}).rows.map(({ topic }) => topic), ['keep/topic']);
  assert.deepEqual(api.queryHistoryLogs({}).rows.map(({ msg }) => msg), ['keep me']);
});

test('treats percent, underscore, and backslash as literal history query text', async (t) => {
  const { api } = await openFixture(t);
  api.saveMessages([
    {
      connection_id: 'conn-fixture', topic: 'metrics/100%/cpu',
      payload: 'under_score path\\root', direction: 'in',
    },
    {
      connection_id: 'conn-fixture', topic: 'metrics/1000/cpu',
      payload: 'underXscore pathroot', direction: 'in',
    },
  ]);
  api.saveLogs([
    { connId: 'conn-fixture', time: '04:00:00', level: 'info', msg: '100% under_score path\\root' },
    { connId: 'conn-fixture', time: '04:00:01', level: 'info', msg: '1000 underXscore pathroot' },
  ]);

  assert.deepEqual(
    api.queryHistoryMessages({ topic: '100%' }).rows.map(({ topic }) => topic),
    ['metrics/100%/cpu'],
  );
  assert.deepEqual(
    api.queryHistoryMessages({ keyword: 'under_score' }).rows.map(({ topic }) => topic),
    ['metrics/100%/cpu'],
  );
  assert.deepEqual(
    api.queryHistoryMessages({ keyword: 'path\\root' }).rows.map(({ topic }) => topic),
    ['metrics/100%/cpu'],
  );
  for (const keyword of ['100%', 'under_score', 'path\\root']) {
    assert.deepEqual(
      api.queryHistoryLogs({ keyword }).rows.map(({ msg }) => msg),
      ['100% under_score path\\root'],
    );
  }
});

test('literal history clearing never expands SQL wildcard characters', async (t) => {
  const { api } = await openFixture(t);
  api.saveMessages([
    { connection_id: 'conn-fixture', topic: 'clear/100%', payload: 'percent', direction: 'in' },
    { connection_id: 'conn-fixture', topic: 'clear/1000', payload: 'percent decoy', direction: 'in' },
    { connection_id: 'conn-fixture', topic: 'clear/backslash', payload: 'path\\root', direction: 'in' },
    { connection_id: 'conn-fixture', topic: 'clear/backslash-decoy', payload: 'pathroot', direction: 'in' },
  ]);
  api.saveLogs([
    { connId: 'conn-fixture', time: '04:00:00', level: 'info', msg: 'clear under_score' },
    { connId: 'conn-fixture', time: '04:00:01', level: 'info', msg: 'keep underXscore' },
  ]);

  api.clearHistoryMessages({ topic: '100%' });
  api.clearHistoryMessages({ keyword: 'path\\root' });
  api.clearHistoryLogs({ keyword: 'under_score' });

  assert.equal(api.queryHistoryMessages({ topic: 'clear/1000' }).total, 1);
  assert.equal(api.queryHistoryMessages({ topic: 'clear/backslash-decoy' }).total, 1);
  assert.equal(api.queryHistoryLogs({ keyword: 'underXscore' }).total, 1);
});

test('rolls back an entire batch when one history row violates the schema', async (t) => {
  const { api } = await openFixture(t);

  assert.throws(() => api.saveMessages([
    { connection_id: 'conn-fixture', topic: 'batch/valid', payload: 'valid', direction: 'in' },
    { connection_id: 'conn-fixture', topic: 'batch/invalid', payload: 'invalid', direction: 'sideways' },
  ]), /CHECK constraint/);

  assert.equal(api.queryHistoryMessages({ topic: 'batch/' }).total, 0);
});

test('clears all history storage while preserving connections, subscriptions, and settings', async (t) => {
  const { api } = await openFixture(t);

  const stats = api.clearHistoryStorage();

  assert.equal(stats.messageCount, 0);
  assert.equal(stats.logCount, 0);
  assert.equal(stats.publishCount, 0);
  assert.equal(stats.totalCount, 0);
  assert.equal(api.getConnections().length, 1);
  assert.equal(api.getSubscriptions('conn-fixture').length, 1);
  assert.deepEqual(api.getAllSettings(), { theme: 'dark' });
});

test('applies WAL, NORMAL synchronous mode, foreign keys, and the current schema version', async (t) => {
  const fixture = await openFixture(t);
  const { api, databasePath } = fixture;

  assert.deepEqual(api.getConnectionPragmas(), {
    foreignKeys: true,
    journalMode: 'wal',
    synchronous: 'normal',
    userVersion: 1,
  });
  fixture.close();

  const inspector = new DatabaseSync(databasePath);
  t.after(() => inspector.close());
  assert.equal(inspector.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(inspector.prepare('PRAGMA user_version').get().user_version, 1);
});

test('creates a fresh current database without sample brokers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-fresh-'));
  let api = null;
  t.after(async () => {
    api?.closeDatabase();
    await rm(directory, { force: true, recursive: true });
  });
  const databasePath = join(directory, 'fresh.db');
  const { createDatabase } = require(databaseModulePath);
  api = createDatabase(databasePath);

  assert.deepEqual(api.getConnections(), []);
  assert.deepEqual(api.getSubscriptions('missing'), []);
  assert.deepEqual(api.getAllSettings(), {});
  assert.equal(api.getStorageStats().totalCount, 0);
});

test('declares and resolves persistence-contract as a direct Electron dependency', async () => {
  const [manifest, lockfile] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);

  assert.equal(manifest.dependencies['@ineed-mqtt-tool/persistence-contract'], '*');
  assert.equal(manifest.devDependencies.electron, '^43.1.0');
  assert.equal(manifest.engines.node, '>=22.13');
  assert.equal(
    lockfile.packages['apps/electron'].dependencies['@ineed-mqtt-tool/persistence-contract'],
    '*',
  );
  assert.equal(
    lockfile.packages['node_modules/@ineed-mqtt-tool/persistence-contract'].resolved,
    'packages/persistence-contract',
  );
  assert.equal(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql'),
    fileURLToPath(new URL('../../../packages/persistence-contract/migrations/001-current-schema.sql', import.meta.url)),
  );
  assert.equal(lockfile.packages['apps/electron'].devDependencies.electron, '^43.1.0');
  const [electronMajor, electronMinor] = lockfile.packages['node_modules/electron'].version
    .split('.').map(Number);
  assert.equal(electronMajor, 43);
  assert.equal(electronMinor >= 1, true);
});

test('fixture generator reproduces the committed database semantic snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-generator-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const generatedPath = join(directory, 'generated.db');
  const {
    createFixtureSemanticSnapshot,
    generateCurrentElectronFixture,
  } = require(fixtureGeneratorPath);

  generateCurrentElectronFixture(generatedPath);

  const committed = createFixtureSemanticSnapshot(fixturePath);
  const generated = createFixtureSemanticSnapshot(generatedPath);
  assert.deepEqual(generated, committed);
  assert.equal(generated.userVersion, 1);
  assert.deepEqual(Object.keys(generated.rows), [
    'connections', 'logs', 'message_history', 'publish_history', 'settings', 'subscriptions',
  ]);
  assert.equal(generated.rows.connections[0].id, 'conn-fixture');
  assert.deepEqual(
    generated.schema.indexes.idx_message_history_conn_time_id.columns,
    ['connection_id', 'created_at', 'id'],
  );
  assert.deepEqual(
    Object.values(generated.schema.indexes)
      .filter(({ unique }) => unique === 1)
      .map(({ table }) => table)
      .toSorted(),
    ['connections', 'settings', 'subscriptions'],
  );
  assert.equal(
    generated.schema.indexes.sqlite_autoindex_connections_1.keyColumns[0].name,
    'id',
  );
  assert.deepEqual(generated.schema.triggers, []);
  assert.equal(generated.schema.tables.message_history.checks.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(generated)), generated);
});

test('fixture contains exactly one representative row in every contract table', () => {
  const database = new DatabaseSync(fixturePath, { readOnly: true });
  try {
    for (const table of [
      'connections', 'subscriptions', 'message_history', 'publish_history', 'settings', 'logs',
    ]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1, table);
    }
  } finally {
    database.close();
  }
});


test('update checkpoint rejects an active WAL reader and leaves the database usable for retry', async t => {
  const { api, databasePath } = await openFixture(t);
  const reader = new DatabaseSync(databasePath);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM settings').all();
    api.saveSetting('update-test', 'before');
    assert.throws(() => api.checkpointForUpdate(), /busy/i);
    reader.exec('ROLLBACK');
    api.checkpointForUpdate();
    api.saveSetting('update-test', 'after');
    assert.equal(api.getAllSettings()['update-test'], 'after');
  } finally { reader.close(); }
});
