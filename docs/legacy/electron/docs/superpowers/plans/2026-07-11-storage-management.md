# Storage Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add accurate SQLite storage statistics and safe history cleanup to Settings in Electron and Tauri.

**Architecture:** Each native database layer owns file accounting and maintenance SQL. The shared renderer reaches those capabilities through the existing runtime adapter and flushes its persistence queues before destructive cleanup.

**Tech Stack:** Vue 3, Node SQLite/Electron IPC, Rust/rusqlite/Tauri commands, Node test runner, Rust tests.

---

### Task 1: Contract Tests

**Files:**
- Create: `tests/storageManagementContract.test.js`
- Modify: `tests/tauriArchitecture.test.js`

- [ ] Add assertions for the shared Settings UI, renderer queue flush, runtime adapter methods, Electron IPC, and Tauri commands.
- [ ] Run `node --test tests/storageManagementContract.test.js` in both projects and verify the new assertions fail because the feature is absent.

### Task 2: Electron Database Contract

**Files:**
- Modify: `electron/database.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/workspace/runtimeAdapter.js`

- [ ] Add count queries and `fs.statSync` accounting for `ineed-mqtt.db`, `-wal`, and `-shm`.
- [ ] Add transactional deletes for only the three history tables, followed by `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM`.
- [ ] Expose `db:get-storage-stats` and `db:clear-history-storage` through IPC and the adapter.
- [ ] Run the focused contract test and verify Electron passes.

### Task 3: Tauri Database Contract

**Files:**
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/workspace/runtimeAdapter.js`

- [ ] Store the database path in `Database`, add serializable storage statistics, and account for the database/WAL/SHM files.
- [ ] Add the same transactional cleanup and maintenance sequence as Electron using a blocking Tauri command.
- [ ] Add Rust tests proving counts, preserved configuration, and post-cleanup writes.
- [ ] Register and map `db_get_storage_stats` and `db_clear_history_storage`.

### Task 4: Shared Settings UI

**Files:**
- Modify: `src/layouts/MqttDeskShell.vue`
- Modify: `src/styles/base.css`

- [ ] Add loading, result, error, refresh, confirmation, and cleanup state.
- [ ] Await `messagePersistence.flush()` and `logPersistence.flush()` before cleanup.
- [ ] Render counts and formatted total/component byte sizes in a restrained Data Storage group.
- [ ] Keep Electron and Tauri frontend files identical.

### Task 5: Verification

- [ ] Run focused Node tests in both projects.
- [ ] Run full `npm test` and errors-only lint in both projects.
- [ ] Run Electron `npm run build` and Tauri Rust tests plus `npm run tauri:build`.
- [ ] Restart both desktop clients and inspect the Settings storage group without clearing the user's current data.
