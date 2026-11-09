import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const minimumNode = [22, 13, 0];
const currentNode = process.versions.node.split('.').map(Number);
if (minimumNode.some((part, index) => (
  currentNode[index] < part
    && minimumNode.slice(0, index).every((minimumPart, partIndex) => (
      currentNode[partIndex] === minimumPart
    ))
))) {
  throw new Error(`Node >=${minimumNode.join('.')} is required; found ${process.versions.node}`);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = join(scriptDirectory, '..', 'fixtures');
const expected = JSON.parse(readFileSync(join(fixturesDirectory, 'expected-records.json'), 'utf8'));
const SIDECAR_SUFFIXES = ['-journal', '-shm', '-wal'];

const ELECTRON_LEGACY_SCHEMA = `
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 1883,
    protocol TEXT DEFAULT 'mqtt',
    path TEXT DEFAULT '',
    client_id TEXT,
    username TEXT DEFAULT '',
    password TEXT DEFAULT '',
    ssl INTEGER DEFAULT 0,
    keepalive INTEGER DEFAULT 60,
    clean_session INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    qos INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    payload TEXT,
    direction TEXT CHECK (direction IN ('in', 'out')),
    qos INTEGER DEFAULT 0,
    retained INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE publish_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    payload TEXT,
    qos INTEGER DEFAULT 0,
    retained INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT,
    time TEXT,
    level TEXT,
    msg TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

const TAURI_LEGACY_SCHEMA = `
  CREATE TABLE connections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER DEFAULT 1883,
    protocol TEXT DEFAULT 'mqtt', path TEXT DEFAULT '', client_id TEXT, username TEXT DEFAULT '', password TEXT DEFAULT '',
    ssl INTEGER DEFAULT 0, keepalive INTEGER DEFAULT 60, clean_session INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY, connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL, qos INTEGER DEFAULT 0, status TEXT DEFAULT 'active', color TEXT DEFAULT '', format TEXT DEFAULT 'json', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL, payload TEXT, direction TEXT CHECK(direction IN ('in','out')),
    qos INTEGER DEFAULT 0, retained INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE publish_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    topic TEXT NOT NULL, payload TEXT, qos INTEGER DEFAULT 0, retained INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT,
    time TEXT, level TEXT, msg TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_message_history_conn_time_id ON message_history (connection_id, created_at, id);
  CREATE INDEX idx_logs_conn_time_id ON logs (connection_id, created_at, id);
`;

function parseOutputDirectory(arguments_) {
  if (arguments_.length === 0) return fixturesDirectory;
  if (arguments_.length !== 2 || arguments_[0] !== '--output-dir') {
    throw new Error('usage: create-database-fixtures.mjs [--output-dir <absolute-directory>]');
  }
  if (!isAbsolute(arguments_[1])) throw new Error('fixture output directory must be absolute');
  const metadata = statSync(arguments_[1]);
  if (!metadata.isDirectory()) throw new Error('fixture output path must be a directory');
  return arguments_[1];
}

function insertRows(database, includeSubscriptionAdditions) {
  const connection = expected.connections[0];
  database.prepare(`
    INSERT INTO connections (
      id, name, host, port, protocol, path, client_id, username, password,
      ssl, keepalive, clean_session, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    connection.id,
    connection.name,
    connection.host,
    connection.port,
    connection.protocol,
    connection.path,
    connection.client_id,
    connection.username,
    connection.password,
    connection.ssl,
    connection.keepalive,
    connection.clean_session,
    connection.sort_order,
    connection.created_at,
    connection.updated_at,
  );

  const subscription = expected.subscriptions[0];
  if (includeSubscriptionAdditions) {
    database.prepare(`
      INSERT INTO subscriptions (
        id, connection_id, topic, qos, status, color, format, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      subscription.id,
      subscription.connection_id,
      subscription.topic,
      subscription.qos,
      subscription.status,
      subscription.color,
      subscription.format,
      subscription.created_at,
    );
  } else {
    database.prepare(`
      INSERT INTO subscriptions (id, connection_id, topic, qos, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      subscription.id,
      subscription.connection_id,
      subscription.topic,
      subscription.qos,
      subscription.status,
      subscription.created_at,
    );
  }

  const messageStatement = database.prepare(`
    INSERT INTO message_history (
      id, connection_id, topic, payload, direction, qos, retained, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const message of expected.messages.toReversed()) {
    messageStatement.run(
      message.id,
      message.connection_id,
      message.topic,
      message.payload,
      message.direction,
      message.qos,
      message.retained,
      message.created_at,
    );
  }

  const published = expected.publishHistory[0];
  database.prepare(`
    INSERT INTO publish_history (
      id, connection_id, topic, payload, qos, retained, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    published.id,
    published.connection_id,
    published.topic,
    published.payload,
    published.qos,
    published.retained,
    published.created_at,
  );

  const log = expected.logs[0];
  database.prepare(`
    INSERT INTO logs (id, connection_id, time, level, msg, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.id, log.connection_id, log.time, log.level, log.msg, log.created_at);

  const settingStatement = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  settingStatement.run('maxRealtimeMessages', expected.settings.maxRealtimeMessages);
  settingStatement.run('theme', expected.settings.theme);
}

function removePrivateArtifacts(databasePath) {
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) rmSync(`${databasePath}${suffix}`, { force: true });
}

function validateFixture(databasePath) {
  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(`${databasePath}${suffix}`)) {
      throw new Error(`unexpected SQLite sidecar ${basename(databasePath)}${suffix}`);
    }
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`fixture integrity check failed: ${integrity}`);
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('fixture foreign key check failed');
    }
    if (Number(database.prepare('PRAGMA user_version').get().user_version) !== 0) {
      throw new Error('legacy fixture user_version must remain zero');
    }
  } finally {
    database.close();
  }
}

function fsyncFile(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported consistently across host filesystems.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The artifact was already file-synced and atomically renamed.
      }
    }
  }
}

function createFixture(outputDirectory, name, { schema, includeSubscriptionAdditions }) {
  const targetPath = join(outputDirectory, name);
  const temporaryPath = join(outputDirectory, `.${name}.${randomUUID()}.tmp`);
  let database;
  try {
    database = new DatabaseSync(temporaryPath, { enableForeignKeyConstraints: true });
    chmodSync(temporaryPath, 0o600);
    database.exec(`
      PRAGMA page_size = 4096;
      PRAGMA auto_vacuum = NONE;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      ${schema}
    `);
    insertRows(database, includeSubscriptionAdditions);
    database.exec('VACUUM;');
    database.close();
    database = undefined;

    validateFixture(temporaryPath);
    fsyncFile(temporaryPath);
    for (const suffix of SIDECAR_SUFFIXES) {
      if (existsSync(`${targetPath}${suffix}`)) {
        throw new Error(`refusing target with SQLite sidecar ${name}${suffix}`);
      }
    }
    if (process.env.INEED_DATABASE_FIXTURE_FAIL_BEFORE_RENAME === name) {
      throw new Error(`injected fixture generation failure before rename: ${name}`);
    }
    const hash = createHash('sha256').update(readFileSync(temporaryPath)).digest('hex');
    const bytes = statSync(temporaryPath).size;
    renameSync(temporaryPath, targetPath);
    fsyncDirectory(outputDirectory);
    return { name, bytes, sha256: hash };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original generation error.
    }
    removePrivateArtifacts(temporaryPath);
    throw error;
  }
}

const outputDirectory = parseOutputDirectory(process.argv.slice(2));
const versionDatabase = new DatabaseSync(':memory:');
const sqliteVersion = versionDatabase.prepare('SELECT sqlite_version() AS version').get().version;
versionDatabase.close();
const results = [
  createFixture(outputDirectory, 'electron-current.db', {
    schema: ELECTRON_LEGACY_SCHEMA,
    includeSubscriptionAdditions: false,
  }),
  createFixture(outputDirectory, 'tauri-current.db', {
    schema: TAURI_LEGACY_SCHEMA,
    includeSubscriptionAdditions: true,
  }),
];

process.stdout.write(`runtime node=${process.versions.node} sqlite=${sqliteVersion}\n`);
for (const result of results) {
  process.stdout.write(
    `${result.name} ${result.bytes} artifact-sha256=${result.sha256}\n`,
  );
}
