import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as schema from '@ineed-mqtt-tool/persistence-contract';

const {
  CONNECTION_PRAGMAS_FILE,
  DATABASE_FILENAME,
  HISTORY_INDEXES,
  LEGACY_COLUMN_MIGRATIONS,
  MIGRATIONS,
  REQUIRED_COLUMNS,
  SCHEMA_VERSION,
  TABLES,
} = schema;

const EXPECTED_TABLES = Object.freeze([
  'connections',
  'subscriptions',
  'message_history',
  'publish_history',
  'settings',
  'logs',
]);

const EXPECTED_INDEXES = Object.freeze([
  'idx_message_history_conn_time_id',
  'idx_logs_conn_time_id',
]);

function column(name, type, options = {}) {
  return {
    name,
    type,
    notnull: options.notnull ?? 0,
    dflt_value: options.default ?? null,
    pk: options.pk ?? 0,
    hidden: 0,
  };
}

const EXPECTED_SCHEMA = {
  connections: [
    column('id', 'TEXT', { pk: 1 }),
    column('name', 'TEXT', { notnull: 1 }),
    column('host', 'TEXT', { notnull: 1 }),
    column('port', 'INTEGER', { default: '1883' }),
    column('protocol', 'TEXT', { default: "'mqtt'" }),
    column('path', 'TEXT', { default: "''" }),
    column('client_id', 'TEXT'),
    column('username', 'TEXT', { default: "''" }),
    column('password', 'TEXT', { default: "''" }),
    column('ssl', 'INTEGER', { default: '0' }),
    column('keepalive', 'INTEGER', { default: '60' }),
    column('clean_session', 'INTEGER', { default: '1' }),
    column('sort_order', 'INTEGER', { default: '0' }),
    column('created_at', 'TEXT', { default: "datetime('now')" }),
    column('updated_at', 'TEXT', { default: "datetime('now')" }),
  ],
  subscriptions: [
    column('id', 'TEXT', { pk: 1 }),
    column('connection_id', 'TEXT'),
    column('topic', 'TEXT', { notnull: 1 }),
    column('qos', 'INTEGER', { default: '0' }),
    column('status', 'TEXT', { default: "'active'" }),
    column('color', 'TEXT', { default: "''" }),
    column('format', 'TEXT', { default: "'json'" }),
    column('created_at', 'TEXT', { default: "datetime('now')" }),
  ],
  message_history: [
    column('id', 'INTEGER', { pk: 1 }),
    column('connection_id', 'TEXT'),
    column('topic', 'TEXT', { notnull: 1 }),
    column('payload', 'TEXT'),
    column('direction', 'TEXT'),
    column('qos', 'INTEGER', { default: '0' }),
    column('retained', 'INTEGER', { default: '0' }),
    column('format', 'TEXT', { default: "''" }),
    column('created_at', 'TEXT', { default: "datetime('now')" }),
  ],
  publish_history: [
    column('id', 'INTEGER', { pk: 1 }),
    column('connection_id', 'TEXT'),
    column('topic', 'TEXT', { notnull: 1 }),
    column('payload', 'TEXT'),
    column('qos', 'INTEGER', { default: '0' }),
    column('retained', 'INTEGER', { default: '0' }),
    column('created_at', 'TEXT', { default: "datetime('now')" }),
  ],
  settings: [
    column('key', 'TEXT', { pk: 1 }),
    column('value', 'TEXT'),
  ],
  logs: [
    column('id', 'INTEGER', { pk: 1 }),
    column('connection_id', 'TEXT'),
    column('time', 'TEXT'),
    column('level', 'TEXT'),
    column('msg', 'TEXT'),
    column('created_at', 'TEXT', { default: "datetime('now')" }),
  ],
};

const EXPECTED_COLUMNS = Object.freeze(Object.fromEntries(
  Object.entries(EXPECTED_SCHEMA).map(([table, columns]) => [
    table,
    Object.freeze(columns.map(({ name }) => name)),
  ]),
));

const EXPECTED_LEGACY_MIGRATIONS = [
  {
    table: 'subscriptions',
    column: 'color',
    sql: "ALTER TABLE subscriptions ADD COLUMN color TEXT DEFAULT ''",
  },
  {
    table: 'subscriptions',
    column: 'format',
    sql: "ALTER TABLE subscriptions ADD COLUMN format TEXT DEFAULT 'json'",
  },
  {
    table: 'message_history',
    column: 'format',
    sql: "ALTER TABLE message_history ADD COLUMN format TEXT DEFAULT ''",
  },
];

const OLD_SCHEMA = `
  CREATE TABLE connections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
    port INTEGER DEFAULT 1883, protocol TEXT DEFAULT 'mqtt', path TEXT DEFAULT '',
    client_id TEXT, username TEXT DEFAULT '', password TEXT DEFAULT '',
    ssl INTEGER DEFAULT 0, keepalive INTEGER DEFAULT 60,
    clean_session INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL, qos INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL, payload TEXT,
    direction TEXT CHECK (direction IN ('in', 'out')),
    qos INTEGER DEFAULT 0, retained INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE publish_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL, payload TEXT, qos INTEGER DEFAULT 0,
    retained INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT,
    time TEXT, level TEXT, msg TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

function migratedElectronSchema({ subscriptionFormat, messageFormat }) {
  return `
    CREATE TABLE connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
      port INTEGER DEFAULT 1883, protocol TEXT DEFAULT 'mqtt', path TEXT DEFAULT '',
      client_id TEXT, username TEXT DEFAULT '', password TEXT DEFAULT '',
      ssl INTEGER DEFAULT 0, keepalive INTEGER DEFAULT 60,
      clean_session INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
      topic TEXT NOT NULL, qos INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      color TEXT DEFAULT ""
      ${subscriptionFormat ? ", format TEXT DEFAULT 'json'" : ''}
    );
    CREATE TABLE message_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
      topic TEXT NOT NULL, payload TEXT,
      direction TEXT CHECK (direction IN ('in', 'out')),
      qos INTEGER DEFAULT 0, retained INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
      ${messageFormat ? ", format TEXT DEFAULT ''" : ''}
    );
    CREATE TABLE publish_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
      topic TEXT NOT NULL, payload TEXT, qos INTEGER DEFAULT 0,
      retained INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT,
      time TEXT, level TEXT, msg TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `;
}

const migrationPath = fileURLToPath(
  new URL('../migrations/001-current-schema.sql', import.meta.url),
);
const connectionPragmasPath = fileURLToPath(
  new URL('../migrations/connection-pragmas.sql', import.meta.url),
);

async function readContracts() {
  const [connectionPragmas, migration] = await Promise.all([
    readFile(connectionPragmasPath, 'utf8'),
    readFile(migrationPath, 'utf8'),
  ]);
  return { connectionPragmas, migration };
}

function createdNames(sql, kind) {
  return [...sql.matchAll(
    new RegExp(`\\bCREATE\\s+${kind}\\s+IF\\s+NOT\\s+EXISTS\\s+([a-z_][a-z0-9_]*)`, 'gi'),
  )].map((match) => match[1]);
}

function sqlStatements(sql) {
  return sql.split(';')
    .map((statement) => statement.trim().replaceAll(/\s+/g, ' '))
    .filter(Boolean);
}

function tableSchema(database, table) {
  return database.prepare(`PRAGMA table_xinfo(${table})`).all().map((entry) => ({
    name: entry.name,
    type: entry.type,
    notnull: entry.notnull,
    dflt_value: entry.dflt_value,
    pk: entry.pk,
    hidden: entry.hidden,
  }));
}

function validateSchema(database) {
  for (const table of EXPECTED_TABLES) {
    assert.deepEqual(tableSchema(database, table), EXPECTED_SCHEMA[table], `${table} schema`);
  }
}

function normalizeDefault(value) {
  if (typeof value !== 'string' || value.length < 2) return value;

  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return value;

  return {
    kind: 'string',
    value: value.slice(1, -1).replaceAll(quote + quote, quote),
  };
}

function normalizeColumnSemantics(columnInfo) {
  if (!columnInfo) return columnInfo;
  return {
    ...columnInfo,
    dflt_value: normalizeDefault(columnInfo.dflt_value),
  };
}

function validateRequiredSchema(database) {
  for (const table of EXPECTED_TABLES) {
    const actualColumns = tableSchema(database, table);
    for (const expectedColumn of EXPECTED_SCHEMA[table]) {
      assert.deepEqual(
        normalizeColumnSemantics(
          actualColumns.find(({ name }) => name === expectedColumn.name),
        ),
        normalizeColumnSemantics(expectedColumn),
        `${table} schema for required column ${expectedColumn.name}`,
      );
    }
  }
}

function applyMigrationContract(database, migration) {
  const currentVersion = database.prepare('PRAGMA user_version').get().user_version;
  const pendingMigrations = MIGRATIONS.filter(({ version }) => version > currentVersion);

  if (pendingMigrations.length === 0) return;

  database.exec('BEGIN');
  try {
    for (const pendingMigration of pendingMigrations) {
      database.exec(migration);
      for (const legacyMigration of pendingMigration.legacyColumns) {
        const columns = database.prepare(
          `PRAGMA table_info(${legacyMigration.table})`,
        ).all().map(({ name }) => name);
        if (!columns.includes(legacyMigration.column)) {
          database.exec(legacyMigration.sql);
        }
      }
      validateRequiredSchema(database);
      database.exec(`PRAGMA user_version = ${pendingMigration.version}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function createTemporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-schema-'));
  const databasePath = join(directory, DATABASE_FILENAME);
  let database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: false,
  });

  t.after(() => {
    database.close();
    return rm(directory, { force: true, recursive: true });
  });

  return {
    closeAndReopen() {
      database.close();
      database = new DatabaseSync(databasePath, {
        enableForeignKeyConstraints: false,
      });
      return database;
    },
    database: () => database,
  };
}

test('exports immutable schema and migration metadata', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(DATABASE_FILENAME, 'ineed-mqtt.db');
  assert.equal(CONNECTION_PRAGMAS_FILE, 'connection-pragmas.sql');
  assert.deepEqual(TABLES, EXPECTED_TABLES);
  assert.deepEqual(HISTORY_INDEXES, EXPECTED_INDEXES);
  assert.deepEqual(REQUIRED_COLUMNS, EXPECTED_COLUMNS);
  assert.deepEqual(LEGACY_COLUMN_MIGRATIONS, EXPECTED_LEGACY_MIGRATIONS);
  assert.deepEqual(MIGRATIONS, [{
    version: 1,
    file: '001-current-schema.sql',
    legacyColumns: LEGACY_COLUMN_MIGRATIONS,
  }]);

  for (const value of [TABLES, HISTORY_INDEXES, REQUIRED_COLUMNS,
    LEGACY_COLUMN_MIGRATIONS, MIGRATIONS]) {
    assert.equal(Object.isFrozen(value), true);
  }
  for (const table of EXPECTED_TABLES) {
    assert.equal(Object.isFrozen(REQUIRED_COLUMNS[table]), true);
  }
  for (const migration of [...LEGACY_COLUMN_MIGRATIONS, ...MIGRATIONS]) {
    assert.equal(Object.isFrozen(migration), true);
  }
  assert.throws(() => TABLES.push('extra'), TypeError);
  assert.throws(() => HISTORY_INDEXES[0] = 'changed', TypeError);
  assert.throws(() => REQUIRED_COLUMNS.logs.push('extra'), TypeError);
  assert.throws(() => REQUIRED_COLUMNS.settings = [], TypeError);
  assert.throws(() => LEGACY_COLUMN_MIGRATIONS[0].sql = 'changed', TypeError);
  assert.throws(() => LEGACY_COLUMN_MIGRATIONS.push({}), TypeError);
  assert.throws(() => MIGRATIONS[0].version = 2, TypeError);
  assert.throws(() => MIGRATIONS.push({}), TypeError);
  assert.throws(() => MIGRATIONS[0].legacyColumns.push({}), TypeError);
});

test('public package exports resolve both migration SQL files', () => {
  const require = createRequire(import.meta.url);
  assert.equal(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql'),
    migrationPath,
  );
  assert.equal(
    require.resolve('@ineed-mqtt-tool/persistence-contract/migrations/connection-pragmas.sql'),
    connectionPragmasPath,
  );
});

test('connection pragmas are separate from transaction-safe schema DDL', async () => {
  const { connectionPragmas, migration } = await readContracts();

  assert.deepEqual(sqlStatements(connectionPragmas), [
    'PRAGMA foreign_keys = ON',
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
  ]);
  assert.doesNotMatch(migration, /\bPRAGMA\b/i);
  assert.deepEqual(createdNames(migration, 'TABLE'), EXPECTED_TABLES);
  assert.deepEqual(createdNames(migration, 'INDEX'), EXPECTED_INDEXES);
  assert.doesNotMatch(migration, /\bINSERT\b/i);
  assert.doesNotMatch(migration, /\bseed\b/i);
});

test('connection setup and transactional migration survive reopening', async (t) => {
  const temporary = await createTemporaryDatabase(t);
  const { connectionPragmas, migration } = await readContracts();
  let database = temporary.database();

  database.exec(connectionPragmas);
  applyMigrationContract(database, migration);
  applyMigrationContract(database, migration);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);

  database = temporary.closeAndReopen();
  assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 0);

  database.exec(connectionPragmas);
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 1);
});

test('legacy columns upgrade inside the migration transaction without data loss', async (t) => {
  const temporary = await createTemporaryDatabase(t);
  const database = temporary.database();
  const { connectionPragmas, migration } = await readContracts();

  database.exec(connectionPragmas);
  database.exec(OLD_SCHEMA);
  database.exec(`
    INSERT INTO connections (id, name, host) VALUES ('c1', 'Legacy', 'localhost');
    INSERT INTO subscriptions (id, connection_id, topic) VALUES ('s1', 'c1', 'legacy/#');
    INSERT INTO message_history (connection_id, topic, payload, direction)
      VALUES ('c1', 'legacy/topic', 'payload', 'in');
  `);

  applyMigrationContract(database, migration);

  assert.deepEqual({ ...database.prepare(
    'SELECT id, connection_id, topic, color, format FROM subscriptions',
  ).get() }, {
    id: 's1', connection_id: 'c1', topic: 'legacy/#', color: '', format: 'json',
  });
  assert.deepEqual({ ...database.prepare(
    'SELECT connection_id, topic, payload, direction, format FROM message_history',
  ).get() }, {
    connection_id: 'c1', topic: 'legacy/topic', payload: 'payload', direction: 'in', format: '',
  });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
});

test('fully migrated Electron defaults validate semantically at user_version zero', async (t) => {
  const temporary = await createTemporaryDatabase(t);
  const database = temporary.database();
  const { connectionPragmas, migration } = await readContracts();

  database.exec(connectionPragmas);
  database.exec(migratedElectronSchema({
    subscriptionFormat: true,
    messageFormat: true,
  }));
  database.exec(`
    INSERT INTO connections (id, name, host) VALUES ('c1', 'Legacy', 'localhost');
    INSERT INTO subscriptions (id, connection_id, topic, color, format)
      VALUES ('s1', 'c1', 'legacy/#', '#123456', 'text');
    INSERT INTO message_history (connection_id, topic, payload, direction, format)
      VALUES ('c1', 'legacy/topic', 'payload', 'in', 'hex');
  `);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);

  applyMigrationContract(database, migration);

  assert.deepEqual({ ...database.prepare(
    'SELECT id, color, format FROM subscriptions WHERE id = \'s1\'',
  ).get() }, { id: 's1', color: '#123456', format: 'text' });
  assert.deepEqual({ ...database.prepare(
    'SELECT payload, format FROM message_history WHERE topic = \'legacy/topic\'',
  ).get() }, { payload: 'payload', format: 'hex' });
  database.exec(`
    INSERT INTO subscriptions (id, connection_id, topic)
      VALUES ('s-default', 'c1', 'defaults/#')
  `);
  assert.deepEqual({ ...database.prepare(
    'SELECT color, format FROM subscriptions WHERE id = \'s-default\'',
  ).get() }, { color: '', format: 'json' });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
});

test('partially migrated Electron defaults add only missing legacy columns', async (t) => {
  const temporary = await createTemporaryDatabase(t);
  const database = temporary.database();
  const { connectionPragmas, migration } = await readContracts();

  database.exec(connectionPragmas);
  database.exec(migratedElectronSchema({
    subscriptionFormat: false,
    messageFormat: false,
  }));
  database.exec(`
    INSERT INTO connections (id, name, host) VALUES ('c1', 'Legacy', 'localhost');
    INSERT INTO subscriptions (id, connection_id, topic, color)
      VALUES ('s1', 'c1', 'legacy/#', '#abcdef');
    INSERT INTO message_history (connection_id, topic, payload, direction)
      VALUES ('c1', 'legacy/topic', 'payload', 'out');
  `);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);

  applyMigrationContract(database, migration);

  assert.deepEqual({ ...database.prepare(
    'SELECT id, color, format FROM subscriptions WHERE id = \'s1\'',
  ).get() }, { id: 's1', color: '#abcdef', format: 'json' });
  assert.deepEqual({ ...database.prepare(
    'SELECT payload, direction, format FROM message_history WHERE topic = \'legacy/topic\'',
  ).get() }, { payload: 'payload', direction: 'out', format: '' });
  database.exec(`
    INSERT INTO subscriptions (id, connection_id, topic)
      VALUES ('s-default', 'c1', 'defaults/#')
  `);
  assert.deepEqual({ ...database.prepare(
    'SELECT color, format FROM subscriptions WHERE id = \'s-default\'',
  ).get() }, { color: '', format: 'json' });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
});

test('incompatible required schema rolls back before setting user_version', async (t) => {
  const temporary = await createTemporaryDatabase(t);
  const database = temporary.database();
  const { connectionPragmas, migration } = await readContracts();

  database.exec(connectionPragmas);
  database.exec(`
    CREATE TABLE connections (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL
    );
  `);

  assert.throws(
    () => applyMigrationContract(database, migration),
    /connections schema/,
  );
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map(({ name }) => name), ['connections']);
});

test('fresh schema has exact semantics, indexes, constraints, and cascades', async (t) => {
  const temporary = await createTemporaryDatabase(t);
  const database = temporary.database();
  const { connectionPragmas, migration } = await readContracts();

  database.exec(connectionPragmas);
  applyMigrationContract(database, migration);

  const tableNames = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map(({ name }) => name);
  const indexNames = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map(({ name }) => name);
  assert.deepEqual(tableNames, [...EXPECTED_TABLES].sort());
  assert.deepEqual(indexNames, [...EXPECTED_INDEXES].sort());
  validateSchema(database);

  for (const index of EXPECTED_INDEXES) {
    assert.deepEqual(
      database.prepare(`PRAGMA index_info(${index})`).all().map(({ name }) => name),
      ['connection_id', 'created_at', 'id'],
      `${index} columns`,
    );
  }

  database.exec("INSERT INTO connections (id, name, host) VALUES ('c1', 'Test', 'localhost')");
  assert.throws(
    () => database.exec(`
      INSERT INTO message_history (connection_id, topic, direction)
        VALUES ('c1', 'invalid', 'sideways')
    `),
    /CHECK constraint failed/,
  );
  database.exec(`
    INSERT INTO subscriptions (id, connection_id, topic) VALUES ('s1', 'c1', 'test/#');
    INSERT INTO message_history (connection_id, topic, direction) VALUES ('c1', 'test/1', 'in');
    INSERT INTO publish_history (connection_id, topic) VALUES ('c1', 'test/2');
    DELETE FROM connections WHERE id = 'c1';
  `);
  for (const table of ['subscriptions', 'message_history', 'publish_history']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});
