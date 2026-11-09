# Subscription lifecycle

The Electron and Tauri clients share subscription lifecycle logic in
`packages/workbench/src/workspace/subscriptionLifecycle.js`. The Shell in
`packages/workbench/src/layouts/MqttToolShell.vue` prepares subscription models,
owns dialogs, button/error state and the application close workflow, and calls
the lifecycle module. See the [current reading map](code-reading-map.md) for
the adapter, native implementation and test paths.

## State ownership and validity

The lifecycle instance owns the per-connection promise queue, pending display
timers, durable pending unsubscribe map and restoration tasks. It receives the
MQTT/database facade, current workspace model access, the Shell's operation
tracker and existing logging function. It reads current connection/subscription
models and updates subscription rows after the original ACK/write boundaries;
dialog state stays in the Shell. Added, removed and copied subscriptions return
a completion boolean, or throw a failure after attempted compensation. A stale
application generation returns false. Restoration contains and logs individual
failures, continues remaining filters, and returns false if any failed.

Three generations have different owners and invalidation conditions:

| Generation | Owner | Invalidated by | Protects |
| --- | --- | --- | --- |
| Application operation | Shell `operationGeneration` | Close drain completes or times out | Late asynchronous results applying effects after shutdown proceeds |
| Manual connection request | Lifecycle `connectionRequestTokens` | Each manual connect, disconnect or connection deletion request | Results belonging to an older user connection request |
| Connection status | Lifecycle `connectionStatusTokens` | Each actual status transition, including automatic reconnect | Old socket ACKs during a newer automatic connection |

Connection IDs identify saved configurations, not sockets. Restoration captures
all three generations and requires the current connection to remain connected.
Duplicate callbacks for the same request/status pair share a task; a newer pair
gets a new task queued behind the old ACK. A task removes its restoration-map
entry only if it still owns that entry. Failed queue tasks release ordering so
later cleanup or restoration can retry.

The Shell registers mutation wrappers and restoration promises in its existing
in-flight operation set. Close refuses new work, removes listeners, waits for
the set with the existing three-second bound, invalidates the application
generation, flushes persistence and disconnects. Pending display timers are
cleared during disconnect after drain. Extraction does not introduce a second
shutdown policy or cancel native ACK promises.

## ACK, persistence and compensation order

| Operation | Success order | Persistence failure after ACK |
| --- | --- | --- |
| Add | SUBSCRIBE ACK → database insert → local active row | Attempt UNSUBSCRIBE; log and throw the primary/rollback error |
| Copy to online connection | SUBSCRIBE ACK → database upsert → local insert/update | Restore existing filter QoS, or UNSUBSCRIBE the new filter; throw combined failure |
| Copy to offline connection | Database upsert → local insert/update | Keep previous local state; no broker change |
| Remove online | Retained covered filters' SUBSCRIBE ACKs → original UNSUBSCRIBE ACK if no identical retained filter → database delete → local remove | Restore original filter/QoS; mark failure if compensation fails |
| Remove offline | Save durable cleanup intent → database delete → local remove | Keep row and cleanup intent; replay protects any still-saved filter |
| Restore | Pending cleanup ACKs → persist cleared queue → saved filters' individual SUBSCRIBE ACKs | Retain cleanup for retry, log failure and continue saved filters |

Runtime and database return shapes retain their existing contracts. Mutation
boundaries reject thrown errors and explicit `{ ok: false }`; restoration marks
an individual subscribe active only on a truthy `result.ok`. The lifecycle does
not reinterpret these existing result checks. Broker success means the native
protocol acknowledgement completed, not merely that an IPC request was accepted.

## Overlapping filters and QoS

Each saved filter is registered with the broker at its configured QoS when it is
added, connected, or restored after automatic reconnect. A broad filter such as
`review/#` no longer suppresses registration of `review/value`. Overlapping
broker subscriptions can produce repeated messages or retained deliveries,
depending on the broker; the workbench does not promise deduplication.

When deleting an online broad filter, the workbench first registers affected
remaining filters on the same connection. This also repairs filters saved by
older versions that relied on coverage without their own broker subscription.
Only after those SUBSCRIBE acknowledgements succeed does it send UNSUBSCRIBE
and remove the local record. Unrelated filters and other connections are left
out of this reconciliation.

A failed replacement SUBSCRIBE or UNSUBSCRIBE keeps the original local record
and shows the error. If local record deletion fails after UNSUBSCRIBE, the
workbench tries to restore the original filter and QoS. A failed restoration is
shown alongside the persistence error and marks the subscription as failed;
connecting again restores saved filters.

## Offline deletion and persistent sessions

Disconnected, connecting, and failed connections allow local subscription
deletion. Before deleting a record, the workbench saves its topic in a durable
cleanup queue in the existing settings table. This applies to clean sessions as
well as persistent sessions, so changing the connection settings does not
silently leave the old broker filter behind. If saving the queue fails, deletion
stops and the local record remains.

The queue uses one key per connection:

```text
mqtt.pendingUnsubscriptions.<connection ID> = JSON array of topic filters
```

No SQLite schema, application ID, runtime data directory, or existing user
settings are changed. Settings used for this queue are read independently of the
ordinary display and application preferences.

On the next successful manual connection or automatic reconnect, the workbench
sends queued UNSUBSCRIBE requests before restoring remaining saved filters.
The queue is loaded on application startup, so the cleanup also survives an app
restart. A topic still present in the local configuration is protected: this
covers interrupted or failed deletion and a topic added again before cleanup.

Queue entries are cleared only after all required UNSUBSCRIBE acknowledgements
succeed and the updated queue is saved. Broker or persistence failure retains
entries for retry on the next connection, records the error in the connection
log, and still restores remaining filters. Retrying an already acknowledged
UNSUBSCRIBE is safe. Broker cleanup requires an available connection; until it
succeeds, a persistent session may still hold deleted filters or previously
queued messages.

Subscription mutations, queue cleanup, and restoration on the same connection
run in order. Reconnect cannot clear a pending deletion's queue while its local
database write is still in progress, and cleanup cannot unsubscribe a new filter
while that filter is being added. Disconnecting cancels restoration before a
late acknowledgement can activate saved filters. If a new connection completes
before the old acknowledgement settles, restoration for the new connection is
queued instead of discarded. Repeated callbacks for the same connection
generation share one restoration task; automatic reconnect status transitions
also invalidate acknowledgements from the previous connection.

## Verification

`npm run test:components` covers overlapping filters and individual QoS,
replacement acknowledgement ordering, online persistence rollback, offline
queue persistence, application-start queue replay, cleanup retries, protected
filters, reconnect during deletion, adding during cleanup, disconnect during restoration, reconnect before a previous acknowledgement
settles, and duplicate reconnect callbacks. The runtime adapter is controlled for these failure cases.

`npm run test:electron:subscriptions` exercises the shared UI with native
Electron IPC, an isolated SQLite profile, and a local Aedes broker, including
persistent-session cleanup across application restart. Renderer previews and
shared component tests also apply to Tauri's shared UI; native Tauri desktop and
Windows/Linux installation acceptance are separate checks.
