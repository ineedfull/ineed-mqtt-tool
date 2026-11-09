# Message History Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist new MQTT history payloads in their selected JSON, TEXT, or HEX format and expose direction, retain, format, and QoS metadata in history.

**Architecture:** A shared renderer utility creates the canonical persisted payload before rows enter the existing batcher. Native database layers add only a `format` column and return it in history queries. The shared history window renders a message-only attribute column while preserving the log layout.

**Tech Stack:** Vue 3, Node test runner, Electron SQLite, Rust/rusqlite, CSS

---

### Task 1: Canonical history payload

**Files:**
- Create: `src/workspace/historyPayload.js`
- Create: `tests/historyPayload.test.js`
- Modify: `src/layouts/MqttDeskShell.vue`

- [ ] Write failing tests proving HEX is compact uppercase, JSON is formatted when valid, invalid JSON and TEXT remain unchanged, and empty formats normalize to TEXT.
- [ ] Run `node --test tests/historyPayload.test.js` and confirm failure because the module is absent.
- [ ] Implement `normalizeHistoryFormat`, `createHistoryPayload`, and `formatStoredHistoryPayload`. HEX uses supplied MQTT hex or the actual encoded publish bytes; JSON uses `JSON.parse` and two-space `JSON.stringify`.
- [ ] Update received and sent persistence rows to include canonical `payload` and `format` before `messagePersistence.enqueue`.
- [ ] Run the focused test and confirm it passes.

### Task 2: Database schema and query contract

**Files:**
- Modify: `electron/database.cjs`
- Modify: `src-tauri/src/database.rs`
- Modify: `tests/historyContract.test.js`

- [ ] Add failing contract and Rust tests for `message_history.format`, idempotent migration, save/query round trips, and old empty-format rows.
- [ ] Run `node --test tests/historyContract.test.js` and `cargo test database` and confirm the new assertions fail.
- [ ] Add `format TEXT DEFAULT ''` to new schemas and guarded `ALTER TABLE` migrations without rewriting old rows.
- [ ] Include `format` in single/batch inserts, Rust `MessageInput`, query row models, and SELECT projections.
- [ ] Re-run focused Node and Rust tests and confirm they pass.

### Task 3: History attributes and formatted content

**Files:**
- Modify: `src/layouts/HistoryWindow.vue`
- Modify: `src/styles/base.css`
- Modify: `tests/historyContract.test.js`

- [ ] Add failing contract assertions for a message-only `标识` column and direction, retained `R`, format, and QoS badges.
- [ ] Add helpers that default old rows to TEXT and format compact HEX as spaced byte pairs for display/copy.
- [ ] Render four columns for message history and retain the existing three-column log layout through modifier classes.
- [ ] Add compact attribute badge styles consistent with the existing subscription badges.
- [ ] Run history contract tests and confirm they pass.

### Task 4: Verification

**Files:**
- Verify all files above in both projects.

- [ ] Run `npm test` in Electron and Tauri.
- [ ] Run `npm run build` in Electron.
- [ ] Run `npm run tauri:build` in Tauri.
- [ ] Restart both desktop clients and manually verify new HEX, JSON, TEXT, retained, and QoS history rows.

The projects are not Git repositories, so there is no commit step.
