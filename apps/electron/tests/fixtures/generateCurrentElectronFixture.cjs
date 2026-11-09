const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  HISTORY_INDEXES,
  MIGRATIONS,
  SCHEMA_VERSION,
  TABLES,
} = require('@ineed-mqtt-tool/persistence-contract');
const { schemaSemantics } = require('../../electron/sqliteSemantics.cjs');

const CONTRACT_PACKAGE = '@ineed-mqtt-tool/persistence-contract';
const DEFAULT_OUTPUT = path.join(__dirname, 'current-electron.db');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function normalizeSnapshotValue(value) {
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return { kind: 'bigint', value: value.toString() };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { kind: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return value;
}

function stableTableRows(database, table) {
  const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all();
  const primaryKey = columns.filter(({ pk }) => Number(pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk));
  const orderColumns = primaryKey.length > 0
    ? primaryKey.map(({ name }) => name)
    : columns.map(({ name }) => name).sort(compareText);
  const orderSql = orderColumns.length > 0
    ? ` ORDER BY ${orderColumns.map(quoteIdentifier).join(', ')}`
    : '';
  return database.prepare(`SELECT * FROM ${quoteIdentifier(table)}${orderSql}`).all()
    .map(row => Object.fromEntries(Object.entries(row)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, value]) => [key, normalizeSnapshotValue(value)])));
}

function createFixtureSemanticSnapshot(databasePath = DEFAULT_OUTPUT) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = [...TABLES].sort(compareText);
    return {
      userVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
      schema: schemaSemantics(database, tables, HISTORY_INDEXES),
      rows: Object.fromEntries(tables.map(table => [table, stableTableRows(database, table)])),
    };
  } finally {
    database.close();
  }
}

function generateCurrentElectronFixture(outputPath = DEFAULT_OUTPUT) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const database = new DatabaseSync(outputPath);
  try {
    for (const migration of MIGRATIONS) {
      const migrationPath = require.resolve(
        `${CONTRACT_PACKAGE}/migrations/${migration.file}`,
      );
      database.exec(fs.readFileSync(migrationPath, 'utf8'));
    }
    database.prepare(`
      INSERT INTO connections (
        id, name, host, port, protocol, path, client_id, username, password,
        ssl, keepalive, clean_session, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'conn-fixture',
      'Fixture broker',
      'fixture.example',
      8883,
      'mqtts',
      '/mqtt',
      'fixture-client',
      'fixture-user',
      'fixture-password',
      1,
      45,
      0,
      7,
      '2025-01-02 03:04:05.006',
      '2025-01-02 03:04:06.007',
    );
    database.prepare(`
      INSERT INTO subscriptions (
        id, connection_id, topic, qos, status, color, format, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sub-fixture',
      'conn-fixture',
      'fixture/#',
      2,
      'pending',
      '#123456',
      'hex',
      '2025-01-02 03:05:00.000',
    );
    database.prepare(`
      INSERT INTO message_history (
        id, connection_id, topic, payload, direction, qos, retained, format, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      101,
      'conn-fixture',
      'fixture/topic',
      'fixture payload',
      'in',
      2,
      0,
      'json',
      '2025-01-02 03:06:00.000',
    );
    database.prepare(`
      INSERT INTO publish_history (
        id, connection_id, topic, payload, qos, retained, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      201,
      'conn-fixture',
      'fixture/publish',
      'published payload',
      1,
      1,
      '2025-01-02 03:07:00.000',
    );
    database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('theme', 'dark');
    database.prepare(`
      INSERT INTO logs (id, connection_id, time, level, msg, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      301,
      'conn-fixture',
      '03:08:00',
      'info',
      'fixture log',
      '2025-01-02 03:08:00.000',
    );
    if (!Number.isSafeInteger(SCHEMA_VERSION) || SCHEMA_VERSION < 0) {
      throw new Error(`invalid schema version ${SCHEMA_VERSION}`);
    }
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; VACUUM;`);
  } finally {
    database.close();
  }

  return outputPath;
}

if (require.main === module) {
  generateCurrentElectronFixture(process.argv[2] || DEFAULT_OUTPUT);
}

module.exports = {
  createFixtureSemanticSnapshot,
  generateCurrentElectronFixture,
};
