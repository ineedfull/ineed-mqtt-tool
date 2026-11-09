# Storage Management Design

## Scope

Add a Data Storage group to Settings for Electron and Tauri. It reports message, log, and publish-history counts plus the real SQLite disk footprint (database, WAL, and SHM files).

Clearing data deletes only `message_history`, `logs`, and `publish_history`. Connections, subscriptions, and settings remain untouched.

## Behavior

- Storage statistics load when Settings is opened and can be refreshed explicitly.
- The renderer waits for message and log persistence queues before clearing.
- The database clears all three history tables in one transaction, checkpoints WAL, and runs `VACUUM`.
- Active MQTT connections remain connected; new records continue to persist after cleanup.
- A confirmation states that connection and subscription configuration is preserved.
- Success and failure are visible in the Settings group and runtime log.

## Contract

Both runtimes expose the same adapter methods:

- `db.getStorageStats()` returns `{ messageCount, logCount, publishCount, totalCount, databaseBytes, walBytes, shmBytes, totalBytes }`.
- `db.clearHistoryStorage()` returns refreshed storage statistics after cleanup.
