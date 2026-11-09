CREATE TABLE IF NOT EXISTS connections (
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

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  qos INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  color TEXT DEFAULT '',
  format TEXT DEFAULT 'json',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  qos INTEGER DEFAULT 0,
  retained INTEGER DEFAULT 0,
  format TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload TEXT,
  qos INTEGER DEFAULT 0,
  retained INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT,
  time TEXT,
  level TEXT,
  msg TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_message_history_conn_time_id
  ON message_history (connection_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_logs_conn_time_id
  ON logs (connection_id, created_at, id);
