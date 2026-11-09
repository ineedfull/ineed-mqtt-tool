# Tauri Electron Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tauri browser-oriented implementation with a Rust-owned database and multi-connection MQTT runtime while matching the finalized Electron frontend.

**Architecture:** Rust modules expose an Electron-equivalent command contract through Tauri `invoke` and emit MQTT messages through Tauri events. A single frontend `runtimeAdapter` hides platform APIs, allowing the Electron layouts and workspace logic to be synchronized without localStorage, browser mqtt.js, or direct SQL access.

**Tech Stack:** Rust, Tauri 2, rusqlite, rumqttc, serde, Vue 3, Vite, node:test.

---

### Task 1: Define the Tauri runtime contract

**Files:**
- Create: `tests/tauriArchitecture.test.js`
- Create: `src/workspace/runtimeAdapter.js`

- [ ] Write a failing contract test asserting that the Tauri adapter exposes Electron-equivalent `db`, `mqtt`, and `window` methods through Tauri `invoke/listen`.
- [ ] Assert that `MqttDeskShell.vue` and `HistoryWindow.vue` import only `runtimeAdapter` for persistence, MQTT, and window operations.
- [ ] Run `node --test tests/tauriArchitecture.test.js` and verify failure because the adapter does not exist.
- [ ] Implement the adapter command mapping and rerun the focused test until green.

The command contract is:

```text
db_get_connections, db_save_connection, db_delete_connection
db_get_subscriptions, db_add_subscription, db_remove_subscription
db_save_message, db_save_messages, db_save_publish
db_save_log, db_save_logs
db_query_history_messages, db_delete_history_message, db_clear_history_messages
db_query_history_logs, db_delete_history_log, db_clear_history_logs
db_get_all_settings, db_save_setting
mqtt_connect, mqtt_disconnect, mqtt_subscribe, mqtt_publish
window_open_history
```

### Task 2: Implement Rust-owned SQLite persistence

**Files:**
- Create: `src-tauri/src/database.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust unit tests in `src-tauri/src/database.rs`

- [ ] Write failing Rust tests for Electron-compatible seed rows, millisecond timestamps, history paging order, and batch transactions.
- [ ] Add `rusqlite`, `serde`, `serde_json`, and `chrono` dependencies.
- [ ] Implement `Database` initialization under the Tauri app data directory, schema creation/migration, indexes, seed data, CRUD, settings, batch writes, and history filters.
- [ ] Register database commands in `lib.rs` and run `cargo test`.

### Task 3: Implement Rust multi-connection MQTT

**Files:**
- Create: `src-tauri/src/mqtt.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust unit tests in `src-tauri/src/mqtt.rs`

- [ ] Write failing tests for protocol parsing and independent connection keys.
- [ ] Add `rumqttc`, `tokio`, and `url` dependencies.
- [ ] Implement a shared map keyed by connection ID, with one `AsyncClient` and event-loop task per connection.
- [ ] Emit `mqtt:message` payloads containing `connId`, topic, text payload, HEX payload, and millisecond time.
- [ ] Register connect/disconnect/subscribe/publish commands and run `cargo test`.

### Task 4: Synchronize the finalized Electron frontend

**Files:**
- Replace: `src/layouts/MqttDeskShell.vue`
- Replace: `src/layouts/HistoryWindow.vue`
- Replace: `src/layouts/PayloadEditor.vue`
- Replace: `src/styles/base.css`
- Synchronize: focused `src/workspace/*.js` modules from Electron
- Preserve/modify: `src/workspace/clipboard.js`

- [ ] Add failing parity tests for the Electron workspace modules and removal of localStorage/browser MQTT paths.
- [ ] Copy finalized Electron layouts, styles, and pure workspace modules.
- [ ] Keep Tauri clipboard behavior and connect layouts to the Tauri runtime adapter.
- [ ] Run `npm test` and `npm run lint -- --quiet`.

### Task 5: Remove legacy platform paths and verify native build

**Files:**
- Delete: `src/workspace/browserStore.js`
- Delete: `src/workspace/mqttService.js`
- Delete: `src/workspace/mqttRuntime.js`
- Delete: `src/workspace/historyStore.js`
- Delete: obsolete mock/query/runtime modules and tests
- Modify: `package.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/Cargo.toml`

- [ ] Remove browser mqtt.js, Tauri SQL plugin dependencies, SQL permissions, and obsolete source files.
- [ ] Run `npm test`, lint, `npm run build`, `cargo test`, and `cargo check`.
- [ ] Run `npm run tauri:build` and inspect the generated desktop bundle.
