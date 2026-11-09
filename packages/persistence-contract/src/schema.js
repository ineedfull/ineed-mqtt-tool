export const SCHEMA_VERSION = 1;
export const DATABASE_FILENAME = 'ineed-mqtt.db';
export const CONNECTION_PRAGMAS_FILE = 'connection-pragmas.sql';

export const TABLES = Object.freeze([
  'connections',
  'subscriptions',
  'message_history',
  'publish_history',
  'settings',
  'logs',
]);

export const HISTORY_INDEXES = Object.freeze([
  'idx_message_history_conn_time_id',
  'idx_logs_conn_time_id',
]);

export const REQUIRED_COLUMNS = Object.freeze({
  connections: Object.freeze([
    'id',
    'name',
    'host',
    'port',
    'protocol',
    'path',
    'client_id',
    'username',
    'password',
    'ssl',
    'keepalive',
    'clean_session',
    'sort_order',
    'created_at',
    'updated_at',
  ]),
  subscriptions: Object.freeze([
    'id',
    'connection_id',
    'topic',
    'qos',
    'status',
    'color',
    'format',
    'created_at',
  ]),
  message_history: Object.freeze([
    'id',
    'connection_id',
    'topic',
    'payload',
    'direction',
    'qos',
    'retained',
    'format',
    'created_at',
  ]),
  publish_history: Object.freeze([
    'id',
    'connection_id',
    'topic',
    'payload',
    'qos',
    'retained',
    'created_at',
  ]),
  settings: Object.freeze(['key', 'value']),
  logs: Object.freeze([
    'id',
    'connection_id',
    'time',
    'level',
    'msg',
    'created_at',
  ]),
});

export const LEGACY_COLUMN_MIGRATIONS = Object.freeze([
  Object.freeze({
    table: 'subscriptions',
    column: 'color',
    sql: "ALTER TABLE subscriptions ADD COLUMN color TEXT DEFAULT ''",
  }),
  Object.freeze({
    table: 'subscriptions',
    column: 'format',
    sql: "ALTER TABLE subscriptions ADD COLUMN format TEXT DEFAULT 'json'",
  }),
  Object.freeze({
    table: 'message_history',
    column: 'format',
    sql: "ALTER TABLE message_history ADD COLUMN format TEXT DEFAULT ''",
  }),
]);

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    file: '001-current-schema.sql',
    legacyColumns: LEGACY_COLUMN_MIGRATIONS,
  }),
]);
