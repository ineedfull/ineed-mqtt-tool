# Runtime-specific About Copy

## Scope

Update the About section in the Electron and Tauri desktop projects so each
application describes only its own runtime and MQTT implementation.

## Electron Copy

- Runtime: Electron
- Built with Vue 3 and Electron
- MQTT communication: mqtt.js
- Supports MQTT 3.1.1 and MQTT 5.0
- SQLite data persistence

## Tauri Copy

- Runtime: Tauri
- Built with Vue 3, Tauri, and Rust
- MQTT communication: native Rust implementation
- Supports MQTT 3.1.1 and MQTT 5.0
- SQLite data persistence

## Constraints

- Remove the shared `Electron + Tauri` desktop-shell description.
- Do not expose internal runtime adapter identifiers in the About copy.
- Keep the existing About layout and styling unchanged.
- Add focused assertions for the runtime-specific copy and run both projects'
  test suites and production frontend builds.
