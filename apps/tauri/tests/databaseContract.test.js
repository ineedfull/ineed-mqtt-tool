import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { HISTORY_INDEXES, SCHEMA_VERSION, TABLES } from '@ineed-mqtt-tool/persistence-contract';

const require = createRequire(import.meta.url);
const fixturePath = fileURLToPath(new URL('./fixtures/current-tauri.db', import.meta.url));
const electronFixturePath = fileURLToPath(
  new URL('../../electron/tests/fixtures/current-electron.db', import.meta.url),
);
const databaseSourcePath = fileURLToPath(
  new URL('../src-tauri/src/database.rs', import.meta.url),
);
const migrationPath = require.resolve(
  '@ineed-mqtt-tool/persistence-contract/migrations/001-current-schema.sql',
);
const sqliteSemanticsPath = fileURLToPath(
  new URL('../../electron/electron/sqliteSemantics.cjs', import.meta.url),
);
const { schemaSemantics } = require(sqliteSemanticsPath);
const FIXTURE_ROWS_SQL = `
  INSERT INTO connections (
    id,name,host,port,protocol,path,client_id,username,password,ssl,keepalive,
    clean_session,sort_order,created_at,updated_at
  ) VALUES (
    'conn-tauri-fixture','Tauri fixture broker','localhost',1883,'mqtt','',
    'tauri-fixture-client','','',0,60,1,1,
    '2025-02-03 04:05:06.007','2025-02-03 04:05:07.008'
  );
  INSERT INTO subscriptions (
    id,connection_id,topic,qos,status,color,format,created_at
  ) VALUES (
    'sub-tauri-fixture','conn-tauri-fixture','fixture/#',1,'active','#123456','hex',
    '2025-02-03 04:06:00.000'
  );
  INSERT INTO message_history (
    id,connection_id,topic,payload,direction,qos,retained,format,created_at
  ) VALUES (
    101,'conn-tauri-fixture','fixture/binary','48656C6C6F00FF','in',1,0,'hex',
    '2025-02-03 04:07:00.000'
  );
  INSERT INTO publish_history (
    id,connection_id,topic,payload,qos,retained,created_at
  ) VALUES (
    201,'conn-tauri-fixture','fixture/publish','published payload',1,1,
    '2025-02-03 04:08:00.000'
  );
  INSERT INTO settings (key,value) VALUES ('theme','dark');
  INSERT INTO logs (
    id,connection_id,time,level,msg,created_at
  ) VALUES (
    301,'conn-tauri-fixture','04:09:00','info','fixture log',
    '2025-02-03 04:09:00.000'
  );
  PRAGMA user_version = 1;
`;

function snapshot(database) {
  return schemaSemantics(database, TABLES, HISTORY_INDEXES);
}

function rowCounts(database) {
  return Object.fromEntries(TABLES.map(table => [
    table,
    Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
  ]));
}

function tableRows(database, table) {
  const primaryKey = database.prepare(`PRAGMA table_xinfo(${table})`).all()
    .filter(column => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(column => column.name);
  const orderBy = primaryKey.length > 0 ? ` ORDER BY ${primaryKey.join(', ')}` : '';
  return database.prepare(`SELECT * FROM ${table}${orderBy}`).all().map(row => ({ ...row }));
}

test('Tauri fixture has the shared schema semantics and representative non-sensitive rows', async () => {
  const migrationSql = await readFile(migrationPath, 'utf8');
  const canonical = new DatabaseSync(':memory:');
  const tauriFixture = new DatabaseSync(fixturePath, { readOnly: true });
  const electronFixture = new DatabaseSync(electronFixturePath, { readOnly: true });
  try {
    canonical.exec(migrationSql);
    canonical.exec(FIXTURE_ROWS_SQL);
    assert.deepEqual(snapshot(tauriFixture), snapshot(canonical));
    assert.deepEqual(snapshot(tauriFixture), snapshot(electronFixture));
    assert.equal(
      Number(tauriFixture.prepare('PRAGMA user_version').get().user_version),
      SCHEMA_VERSION,
    );
    assert.deepEqual(rowCounts(tauriFixture), Object.fromEntries(TABLES.map(table => [table, 1])));
    for (const table of TABLES) {
      assert.deepEqual(tableRows(tauriFixture, table), tableRows(canonical, table), table);
    }

    const connection = tauriFixture.prepare('SELECT * FROM connections').get();
    assert.deepEqual(
      { id: connection.id, host: connection.host, username: connection.username, password: connection.password },
      { id: 'conn-tauri-fixture', host: 'localhost', username: '', password: '' },
    );
    assert.equal(
      tauriFixture.prepare('SELECT payload FROM message_history').get().payload,
      '48656C6C6F00FF',
      'binary payload uses the shared uppercase hex TEXT encoding without truncation',
    );
    assert.deepEqual(
      { ...tauriFixture.prepare('SELECT id, connection_id, topic, qos, status, format FROM subscriptions').get() },
      { id: 'sub-tauri-fixture', connection_id: 'conn-tauri-fixture', topic: 'fixture/#', qos: 1, status: 'active', format: 'hex' },
    );
    assert.deepEqual(
      { ...tauriFixture.prepare('SELECT id, connection_id, topic, payload, qos, retained FROM publish_history').get() },
      { id: 201, connection_id: 'conn-tauri-fixture', topic: 'fixture/publish', payload: 'published payload', qos: 1, retained: 1 },
    );
    assert.deepEqual({ ...tauriFixture.prepare('SELECT key, value FROM settings').get() }, { key: 'theme', value: 'dark' });
    assert.deepEqual(
      { ...tauriFixture.prepare('SELECT id, connection_id, level, msg FROM logs').get() },
      { id: 301, connection_id: 'conn-tauri-fixture', level: 'info', msg: 'fixture log' },
    );
  } finally {
    canonical.close();
    tauriFixture.close();
    electronFixture.close();
  }
});

test('Rust database uses the shared migration as its only baseline and exposes exactly 21 commands', async () => {
  const [source, migrationSql] = await Promise.all([
    readFile(databaseSourcePath, 'utf8'),
    readFile(migrationPath, 'utf8'),
  ]);
  assert.match(
    source,
    /const BASELINE_SCHEMA:\s*&str\s*=\s*include_str!\(\s*"\.\.\/\.\.\/\.\.\/\.\.\/packages\/persistence-contract\/migrations\/001-current-schema\.sql"\s*\);/,
  );
  assert.equal(source.includes('CREATE TABLE IF NOT EXISTS connections'), false);
  assert.equal(
    createHash('sha256').update(migrationSql).digest('hex'),
    'd706479c39c53fdcfe850efd77093382956ff72beac9be3fcdfb267068ac4f0f',
  );

  const commands = [...source.matchAll(/pub async fn (db_[a-z_]+)\s*\(/g)].map(match => match[1]);
  assert.equal(commands.length, 21);
  assert.equal(new Set(commands).size, 21);
  assert.equal(commands.includes('db_save_message'), false);
  assert.equal(commands.includes('db_save_log'), false);
  assert.equal(commands.includes('db_get_publish_history'), true);
  assert.match(
    source,
    /pub async fn db_get_publish_history\([\s\S]*?conn_id: String,[\s\S]*?limit: i64/,
  );
  assert.equal((source.match(/tokio::task::spawn_blocking/g) || []).length, 1);
});
