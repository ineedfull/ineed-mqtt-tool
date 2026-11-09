# Tauri Electron Parity Design

## Goal

Bring the Tauri edition of Ineed MQTT Desk to functional parity with the finalized Electron edition while preserving a clear platform boundary.

## Platform Boundary

The Vue application depends only on a `runtimeAdapter` contract. It must not directly access localStorage, Tauri SQL, browser mqtt.js, or Tauri globals outside the adapter.

The Rust process owns:

- connection, subscription, setting, publish, message, and log persistence
- database schema migration and Electron-compatible seed data
- all MQTT network connections and their independent lifecycle
- MQTT subscribe, publish, disconnect, reconnect, and message events
- opening and focusing independent history windows

## Frontend Parity

The finalized Electron frontend is the behavioral and visual source of truth. Tauri receives the same:

- connection and subscription models
- realtime message and log limits
- log-level filtering
- batched message and log persistence
- subscription duplicate warnings, colors, matching, and filtering
- JSON/TEXT/HEX display and publish behavior
- history filtering, paging, millisecond timestamps, deletion, and clearing
- layout, styles, CodeMirror editor, copy actions, and collapsed navigation behavior

Only `runtimeAdapter` and platform clipboard/window integration differ between editions.

## Rust Components

### Database

A Rust database service uses SQLite and exposes Tauri commands matching the Electron preload database contract. SQL paging orders history by `created_at DESC, id DESC`, timestamps include milliseconds, and batch writes use transactions.

### MQTT

A Rust MQTT service uses one client/event-loop task per connection. A shared state map is keyed by connection ID, so connecting one broker cannot replace or disconnect another. Incoming payloads emit text and HEX data to all relevant Tauri windows.

### Window Management

A Rust command creates or focuses `history-messages` and `history-logs` windows with the same query parameters used by the Electron edition.

## Migration

Remove the legacy browser-oriented path after the replacement contract is working:

- `browserStore.js`
- browser `mqttService.js` and `mqttRuntime.js`
- direct `historyStore.js` SQL-plugin access
- legacy mock model and duplicate query/runtime helpers
- optional web mqtt.js dependency
- Tauri SQL plugin and permissions when Rust persistence fully replaces them

No localStorage data migration is required because the approved persistence source is the Rust-owned database.

## Delivery Phases

1. Establish Rust database commands and the Tauri runtime adapter.
2. Add Rust multi-connection MQTT and event delivery.
3. Synchronize the Electron frontend and remove legacy browser paths.
4. Verify Node tests, Rust tests, lint, Vite build, Cargo check, and native Tauri build.

Each phase must leave the application compiling and covered by contract tests.
