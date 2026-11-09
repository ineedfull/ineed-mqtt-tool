const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { isDeepStrictEqual } = require('node:util');
const { schemaSemantics } = require('./sqliteSemantics.cjs');

const {
  CONNECTION_PRAGMAS_FILE,
  DATABASE_FILENAME,
  HISTORY_INDEXES,
  MIGRATIONS,
  REQUIRED_COLUMNS,
} = require('@ineed-mqtt-tool/persistence-contract');

const CONTRACT_PACKAGE = '@ineed-mqtt-tool/persistence-contract';
const SYNCHRONOUS_NAMES = Object.freeze(['off', 'normal', 'full', 'extra']);
const LEGACY_USER_DATA_DIR_NAMES = Object.freeze(['ineed-mqtt-desk', 'Ineed MQTT Desk']);

function readContractSql(file) {
  const resolved = require.resolve(`${CONTRACT_PACKAGE}/migrations/${file}`);
  return fs.readFileSync(resolved, 'utf8');
}

const connectionPragmasSql = readContractSql(CONNECTION_PRAGMAS_FILE);
const migrationSqlByVersion = new Map(
  MIGRATIONS.map(migration => [migration.version, readContractSql(migration.file)]),
);

function canonicalSchemaSemantics() {
  const canonical = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  try {
    for (const migration of MIGRATIONS) {
      canonical.exec(migrationSqlByVersion.get(migration.version));
    }
    return schemaSemantics(canonical, Object.keys(REQUIRED_COLUMNS), HISTORY_INDEXES);
  } finally {
    canonical.close();
  }
}

const canonicalSchema = canonicalSchemaSemantics();

function defaultDatabasePath(app = require('electron').app) {
  const userDataPath = app.getPath('userData');
  const currentPath = path.join(userDataPath, DATABASE_FILENAME);
  if (fs.existsSync(currentPath)) return currentPath;
  for (const directoryName of LEGACY_USER_DATA_DIR_NAMES) {
    const legacyPath = path.join(path.dirname(userDataPath), directoryName, DATABASE_FILENAME);
    if (legacyPath !== currentPath && fs.existsSync(legacyPath)) return legacyPath;
  }
  return currentPath;
}

function createDatabase(databasePath = defaultDatabasePath()) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '') {
    throw new TypeError('databasePath must be a non-empty string');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false });
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error('database is closed');
  }

  function rows(sql, params = []) {
    assertOpen();
    return database.prepare(sql).all(...params).map(row => ({ ...row }));
  }

  function row(sql, params = []) {
    assertOpen();
    const value = database.prepare(sql).get(...params);
    return value ? { ...value } : null;
  }

  function run(sql, params = []) {
    assertOpen();
    return database.prepare(sql).run(...params);
  }

  function transaction(callback, mode = '') {
    assertOpen();
    database.exec(`BEGIN${mode ? ` ${mode}` : ''}`);
    try {
      const result = callback();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  function validateRequiredSchema() {
    const actualSchema = schemaSemantics(
      database,
      Object.keys(REQUIRED_COLUMNS),
      HISTORY_INDEXES,
    );
    if (!isDeepStrictEqual(actualSchema, canonicalSchema)) {
      throw new Error('database schema semantics do not match the persistence contract');
    }
  }

  function migrateSchema() {
    const currentVersion = Number(row('PRAGMA user_version')?.user_version || 0);
    const latestVersion = MIGRATIONS.at(-1)?.version || 0;
    if (currentVersion > latestVersion) {
      throw new Error(
        `database schema version ${currentVersion} is newer than supported version ${latestVersion}`,
      );
    }

    const pending = MIGRATIONS.filter(({ version }) => version > currentVersion);
    const additiveMigrations = MIGRATIONS.flatMap(migration => migration.legacyColumns);
    const hasMissingAdditiveMigration = additiveMigrations.some(additiveMigration => {
      const table = database.prepare(`PRAGMA table_xinfo(${additiveMigration.table})`).all();
      return !table.some(({ name }) => name === additiveMigration.column);
    });
    if (pending.length > 0 || hasMissingAdditiveMigration) {
      transaction(() => {
        for (const migration of pending) {
          database.exec(migrationSqlByVersion.get(migration.version));
        }
        for (const additiveMigration of additiveMigrations) {
          const table = database.prepare(`PRAGMA table_xinfo(${additiveMigration.table})`).all();
          if (!table.some(({ name }) => name === additiveMigration.column)) {
            database.exec(additiveMigration.sql);
          }
        }
        for (const migration of pending) {
          validateRequiredSchema();
          if (!Number.isSafeInteger(migration.version) || migration.version < 0) {
            throw new Error(`invalid schema migration version ${migration.version}`);
          }
          database.exec(`PRAGMA user_version = ${migration.version}`);
        }
      }, 'IMMEDIATE');
    }

    validateRequiredSchema();
  }

  try {
    database.exec(connectionPragmasSql);
    migrateSchema();
  } catch (error) {
    database.close();
    closed = true;
    throw error;
  }

  function closeDatabase() {
    if (closed) return;
    closed = true;
    database.close();
  }

  function checkpointForUpdate() {
    const result = database.prepare('PRAGMA wal_checkpoint(FULL)').get();
    if (result.busy !== 0) throw new Error('SQLite checkpoint is busy');
  }

  function fileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  function getStorageStats() {
    const messageCount = Number(row('SELECT COUNT(*) AS total FROM message_history')?.total || 0);
    const logCount = Number(row('SELECT COUNT(*) AS total FROM logs')?.total || 0);
    const publishCount = Number(row('SELECT COUNT(*) AS total FROM publish_history')?.total || 0);
    const databaseBytes = fileSize(databasePath);
    const walBytes = fileSize(`${databasePath}-wal`);
    const shmBytes = fileSize(`${databasePath}-shm`);
    return {
      messageCount,
      logCount,
      publishCount,
      totalCount: messageCount + logCount + publishCount,
      databaseBytes,
      walBytes,
      shmBytes,
      totalBytes: databaseBytes + walBytes + shmBytes,
    };
  }

  function clearHistoryStorage() {
    transaction(() => {
      database.exec(`
        DELETE FROM message_history;
        DELETE FROM logs;
        DELETE FROM publish_history;
      `);
    }, 'IMMEDIATE');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.exec('VACUUM');
    return getStorageStats();
  }

  function pad(value, length = 2) {
    return String(value).padStart(length, '0');
  }

  function historyTimestamp(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.`
      + pad(date.getMilliseconds(), 3);
  }

  function normalizedInteger(value, fallback, minimum, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
  }

  function filterString(value) {
    return value == null ? '' : String(value);
  }

  function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, '\\$&');
  }

  function normalizeHistoryFilter(filter = {}) {
    if (filter == null || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new TypeError('history filter must be an object');
    }
    const page = normalizedInteger(filter.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = normalizedInteger(filter.pageSize, 100, 20, 500);
    const direction = filterString(filter.direction);
    if (direction !== '' && direction !== 'in' && direction !== 'out') {
      throw new RangeError('history direction must be in or out');
    }
    return {
      connId: filterString(filter.connId),
      direction,
      topic: filterString(filter.topic),
      level: filterString(filter.level),
      keyword: filterString(filter.keyword),
      page,
      pageSize,
      offset: (page - 1) * pageSize,
    };
  }

  function appendLike(where, params, columns, keyword) {
    if (!keyword) return;
    where.push(`(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    columns.forEach(() => params.push(`%${escapeLike(keyword)}%`));
  }

  function normalizeHexHistoryKeyword(keyword) {
    const compact = String(keyword || '').replace(/^0x/i, '').replace(/\s+/g, '');
    return compact && /^[a-f\d]+$/i.test(compact) ? compact.toUpperCase() : '';
  }

  function buildMessageHistoryFilter(filter = {}) {
    const normalized = normalizeHistoryFilter(filter);
    const where = [];
    const params = [];
    if (normalized.connId) {
      where.push('connection_id = ?');
      params.push(normalized.connId);
    }
    if (normalized.direction) {
      where.push('direction = ?');
      params.push(normalized.direction);
    }
    if (normalized.topic) {
      where.push("topic LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(normalized.topic)}%`);
    }
    const hexKeyword = normalizeHexHistoryKeyword(normalized.keyword);
    if (hexKeyword && hexKeyword !== normalized.keyword.toUpperCase()) {
      where.push(
        "(topic LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\' "
          + "OR (format = 'hex' AND payload LIKE ? ESCAPE '\\'))",
      );
      params.push(
        `%${escapeLike(normalized.keyword)}%`,
        `%${escapeLike(normalized.keyword)}%`,
        `%${escapeLike(hexKeyword)}%`,
      );
    } else {
      appendLike(where, params, ['topic', 'payload'], normalized.keyword);
    }
    return {
      whereSql: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '',
      params,
      filter: normalized,
    };
  }

  function buildLogHistoryFilter(filter = {}) {
    const normalized = normalizeHistoryFilter(filter);
    const where = [];
    const params = [];
    if (normalized.connId) {
      where.push('connection_id = ?');
      params.push(normalized.connId);
    }
    if (normalized.level) {
      where.push('level = ?');
      params.push(normalized.level);
    }
    appendLike(where, params, ['level', 'msg'], normalized.keyword);
    return {
      whereSql: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '',
      params,
      filter: normalized,
    };
  }

  function queryHistoryRows(table, selectSql, filterParts, orderSql) {
    const total = Number(row(
      `SELECT COUNT(*) AS total FROM ${table}${filterParts.whereSql}`,
      filterParts.params,
    )?.total || 0);
    const historyRows = rows(
      `${selectSql}${filterParts.whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
      [...filterParts.params, filterParts.filter.pageSize, filterParts.filter.offset],
    );
    return {
      rows: historyRows,
      total,
      page: filterParts.filter.page,
      pageSize: filterParts.filter.pageSize,
    };
  }

  function getConnections() {
    return rows('SELECT * FROM connections ORDER BY sort_order, id');
  }

  function saveConnection(connection) {
    if (connection == null || typeof connection !== 'object' || Array.isArray(connection)) {
      throw new TypeError('connection must be an object');
    }
    const id = filterString(connection.id) || `conn-${randomUUID()}`;
    const timestamp = historyTimestamp();
    run(`
      INSERT INTO connections (
        id, name, host, port, protocol, path, client_id, username, password,
        ssl, keepalive, clean_session, sort_order, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        port = excluded.port,
        protocol = excluded.protocol,
        path = excluded.path,
        client_id = excluded.client_id,
        username = excluded.username,
        password = excluded.password,
        ssl = excluded.ssl,
        keepalive = excluded.keepalive,
        clean_session = excluded.clean_session,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `, [
      id,
      connection.name,
      connection.host,
      connection.port ?? 1883,
      connection.protocol ?? 'mqtt',
      connection.path ?? '',
      connection.client_id ?? null,
      connection.username ?? '',
      connection.password ?? '',
      connection.ssl ? 1 : 0,
      connection.keepalive ?? 60,
      connection.clean_session === false || connection.clean_session === 0 ? 0 : 1,
      connection.sort_order ?? 0,
      timestamp,
    ]);
    return id;
  }

  function deleteConnection(id) {
    run('DELETE FROM connections WHERE id = ?', [id]);
  }

  function getSubscriptions(connectionId) {
    return rows(
      'SELECT * FROM subscriptions WHERE connection_id = ? ORDER BY created_at, id',
      [connectionId],
    );
  }

  function addSubscription(subscription) {
    if (subscription == null || typeof subscription !== 'object' || Array.isArray(subscription)) {
      throw new TypeError('subscription must be an object');
    }
    run(`
      INSERT INTO subscriptions (id, connection_id, topic, qos, status, color, format)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        connection_id = excluded.connection_id,
        topic = excluded.topic,
        qos = excluded.qos,
        status = excluded.status,
        color = excluded.color,
        format = excluded.format
    `, [
      subscription.id,
      subscription.connection_id,
      subscription.topic,
      subscription.qos ?? 0,
      subscription.status ?? 'active',
      subscription.color ?? '',
      subscription.format ?? 'json',
    ]);
  }

  function removeSubscription(id) {
    run('DELETE FROM subscriptions WHERE id = ?', [id]);
  }

  function getMessages(connectionId, limit = 200) {
    const normalizedLimit = normalizedInteger(limit, 200, 1, 500);
    return rows(
      'SELECT * FROM message_history WHERE connection_id = ? '
        + 'ORDER BY created_at DESC, id DESC LIMIT ?',
      [connectionId, normalizedLimit],
    ).reverse();
  }

  function getMessageCounts() {
    return rows(`
      SELECT connection_id,
        SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS messages_in,
        SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS messages_out
      FROM message_history
      GROUP BY connection_id
      ORDER BY connection_id
    `);
  }

  function insertMessage(message, timestamp = historyTimestamp()) {
    run(`
      INSERT INTO message_history (
        connection_id, topic, payload, direction, qos, retained, format, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      message.connection_id,
      message.topic,
      message.payload ?? null,
      message.direction,
      message.qos ?? 0,
      message.retained ? 1 : 0,
      message.format ?? '',
      timestamp,
    ]);
  }

  function saveMessage(message) {
    insertMessage(message);
  }

  function saveMessages(messages = []) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    if (messages.length === 0) return;
    transaction(() => {
      for (const message of messages) insertMessage(message);
    });
  }

  function clearMessages(connectionId) {
    run('DELETE FROM message_history WHERE connection_id = ?', [connectionId]);
  }

  function queryHistoryMessages(filter) {
    return queryHistoryRows(
      'message_history',
      `SELECT id, connection_id, topic, payload, direction, qos, retained,
        COALESCE(format, 'text') AS format, created_at FROM message_history`,
      buildMessageHistoryFilter(filter),
      'created_at DESC, id DESC',
    );
  }

  function deleteHistoryMessage(id) {
    run('DELETE FROM message_history WHERE id = ?', [id]);
  }

  function clearHistoryMessages(filter) {
    const { whereSql, params } = buildMessageHistoryFilter(filter);
    run(`DELETE FROM message_history${whereSql}`, params);
  }

  function getPublishHistory(connectionId, limit = 50) {
    const normalizedLimit = normalizedInteger(limit, 50, 1, 500);
    return rows(
      'SELECT * FROM publish_history WHERE connection_id = ? '
        + 'ORDER BY created_at DESC, id DESC LIMIT ?',
      [connectionId, normalizedLimit],
    );
  }

  function savePublish(message) {
    run(`
      INSERT INTO publish_history (connection_id, topic, payload, qos, retained)
      VALUES (?, ?, ?, ?, ?)
    `, [
      message.connection_id,
      message.topic,
      message.payload ?? null,
      message.qos ?? 0,
      message.retained ? 1 : 0,
    ]);
  }

  function getSetting(key) {
    return row('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  }

  function saveSetting(key, value) {
    run(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, String(value)]);
  }

  function getAllSettings() {
    return Object.fromEntries(rows('SELECT key, value FROM settings ORDER BY key')
      .map(setting => [setting.key, setting.value]));
  }

  function insertLog(entry, timestamp = historyTimestamp()) {
    run(`
      INSERT INTO logs (connection_id, time, level, msg, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [entry.connId ?? entry.connection_id, entry.time, entry.level, entry.msg, timestamp]);
  }

  function saveLog(entry) {
    insertLog(entry);
  }

  function saveLogs(logs = []) {
    if (!Array.isArray(logs)) throw new TypeError('logs must be an array');
    if (logs.length === 0) return;
    transaction(() => {
      for (const entry of logs) insertLog(entry);
    });
  }

  function getLogs(connectionId, limit = 500) {
    const normalizedLimit = normalizedInteger(limit, 500, 1, 500);
    return rows(
      'SELECT * FROM logs WHERE connection_id = ? '
        + 'ORDER BY created_at DESC, time DESC, id DESC LIMIT ?',
      [connectionId, normalizedLimit],
    ).reverse();
  }

  function clearLogs(connectionId) {
    run('DELETE FROM logs WHERE connection_id = ?', [connectionId]);
  }

  function queryHistoryLogs(filter) {
    return queryHistoryRows(
      'logs',
      'SELECT id, connection_id, time, level, msg, created_at FROM logs',
      buildLogHistoryFilter(filter),
      'created_at DESC, time DESC, id DESC',
    );
  }

  function deleteHistoryLog(id) {
    run('DELETE FROM logs WHERE id = ?', [id]);
  }

  function clearHistoryLogs(filter) {
    const { whereSql, params } = buildLogHistoryFilter(filter);
    run(`DELETE FROM logs${whereSql}`, params);
  }

  function getConnectionPragmas() {
    const synchronous = Number(row('PRAGMA synchronous')?.synchronous);
    return {
      foreignKeys: Number(row('PRAGMA foreign_keys')?.foreign_keys) === 1,
      journalMode: String(row('PRAGMA journal_mode')?.journal_mode || '').toLowerCase(),
      synchronous: SYNCHRONOUS_NAMES[synchronous] || String(synchronous),
      userVersion: Number(row('PRAGMA user_version')?.user_version || 0),
    };
  }

  return Object.freeze({
    closeDatabase,
    checkpointForUpdate,
    getConnections,
    saveConnection,
    deleteConnection,
    getSubscriptions,
    addSubscription,
    removeSubscription,
    getMessages,
    getMessageCounts,
    saveMessage,
    saveMessages,
    clearMessages,
    queryHistoryMessages,
    deleteHistoryMessage,
    clearHistoryMessages,
    getPublishHistory,
    savePublish,
    getSetting,
    saveSetting,
    getAllSettings,
    saveLog,
    saveLogs,
    getLogs,
    clearLogs,
    queryHistoryLogs,
    deleteHistoryLog,
    clearHistoryLogs,
    getStorageStats,
    clearHistoryStorage,
    getConnectionPragmas,
  });
}

module.exports = { createDatabase, defaultDatabasePath, LEGACY_USER_DATA_DIR_NAMES };
