# MQTT Connection Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce useful deduplicated disconnect logs and allow users to terminate initial connection or automatic reconnect in Electron and Tauri.

**Architecture:** Native MQTT runtimes own connection generations, retry counters, outage timestamps, and conservative error classification. They emit one shared structured status contract. The renderer maps that contract to concise status labels, state-aware action buttons, and one primary log per outage cycle.

**Tech Stack:** mqtt.js, Rust/rumqttc, Tauri events, Electron IPC, Vue 3, Node and Rust tests

---

### Task 1: Shared diagnostic presentation

**Files:**
- Create: `src/workspace/connectionDiagnostics.js`
- Create: `tests/connectionDiagnostics.test.js`
- Modify: `src/layouts/MqttDeskShell.vue`

- [ ] Write failing tests for source labels, initial failure, one reconnect warning, cancellation wording, and reconnect success duration/attempt text.
- [ ] Implement pure helpers for normalizing status events and producing primary log entries.
- [ ] Track outage cycles by connection in the renderer so repeated native retry events do not append repeated Warn entries.
- [ ] Run the focused test and confirm it passes.

### Task 2: Electron lifecycle and cancellation

**Files:**
- Create: `electron/mqttDiagnostics.cjs`
- Create: `tests/electronMqttDiagnostics.test.js`
- Modify: `electron/main.cjs`

- [ ] Write failing tests for conservative classification and the structured status payload contract.
- [ ] Replace raw client entries with lifecycle handles containing generation, client, connected-once, outage start, retry count, and stopped state.
- [ ] Emit `connecting` once for initial connection, `reconnecting` once per outage cycle, classified `error` for initial failure, and enriched `connected` after recovery.
- [ ] Make `mqtt:disconnect` invalidate the generation and close the client so stale callbacks cannot restore state.
- [ ] Keep low-level mqtt.js event details in the native debug log while emitting one renderer outage event.
- [ ] Run focused diagnostics and architecture tests.

### Task 3: Tauri lifecycle and cancellation

**Files:**
- Modify: `src-tauri/src/mqtt.rs`
- Modify: `tests/tauriArchitecture.test.js`

- [ ] Add failing Rust tests for error classification and status metadata serialization.
- [ ] Extend `MqttStatusEvent` with source, code, attempt, and disconnected timestamp.
- [ ] Track outage start and retry attempts inside each event-loop task; emit `reconnecting` after a post-CONNACK error and enriched `connected` after recovery.
- [ ] Abort and remove the current generation on disconnect so initial connection and reconnect are both cancellable.
- [ ] Ensure initial failure ends without an infinite retry and carries a classified error.
- [ ] Run `cargo test mqtt` and the Tauri architecture test.

### Task 4: State-aware connection action

**Files:**
- Modify: `src/layouts/MqttDeskShell.vue`
- Modify: `src/styles/base.css`
- Modify: `tests/mqttStatusContract.test.js`

- [ ] Add failing assertions for `正在连接`, `正在重连`, `终止`, and `停止重连`.
- [ ] Add `reconnecting` to the renderer state labels and warning-color styles.
- [ ] Route `connecting` and `reconnecting` action clicks through one async stop function that clears subscription pending state after the native runtime confirms cancellation.
- [ ] Keep `连接` for disconnected/error and `断开` for connected.
- [ ] Re-run focused status tests.

### Task 5: Verification

**Files:**
- Verify all files above in both projects.

- [ ] Run `npm test` in Electron and Tauri.
- [ ] Run `npm run build` in Electron.
- [ ] Run `npm run tauri:build` in Tauri.
- [ ] Restart both clients and manually verify initial cancellation, reconnect cancellation, one warning per outage, and reconnect summary logs.

The projects are not Git repositories, so there is no commit step.
