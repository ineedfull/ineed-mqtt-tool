# MQTT Load Test Design

## Scope

Add a reusable external MQTT traffic generator for controlled receive-path testing of Electron and Tauri against the private EMQX 5.8.9 broker. Credentials are supplied only through environment variables.

## Safety

- Default maximum rate is 500 messages per second.
- Higher rates require `ALLOW_HIGH_RATE=true`.
- Default duration is 30 seconds, with 16 topics and 512-byte JSON payloads.
- Each run uses a unique topic root and Client ID.
- The generator subscribes to its own run root to report sent, received, lost, throughput, and latency.
- SIGINT stops publishing and closes the MQTT client cleanly.

## Client Validation

Electron and Tauri use distinct Client IDs and subscribe to `ineed/loadtest/#`. Each stage compares generator counts, application counters, database deltas, process CPU, process memory, disconnects, and persistence-drop logs.
