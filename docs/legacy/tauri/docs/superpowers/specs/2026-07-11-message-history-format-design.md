# Message History Format Design

## Goal

Persist each new MQTT history message in the format selected when the message is received or sent, so HEX content is searchable and history clearly shows direction, retain state, message format, and QoS. Electron and Tauri must use the same schema and behavior.

## Scope

- Add a `format` field to message history.
- Store HEX content directly in the existing `payload` field.
- Format JSON before persistence when it is valid.
- Keep TEXT payloads unchanged.
- Add a message attribute column to the history list.
- Show the same attributes in message detail and copied text.
- Keep history keyword search on `topic` and `payload`.

Existing history rows are not migrated or backfilled. They have no test-stage value and are treated as TEXT when `format` is empty.

## Schema

Add one nullable/defaulted column to `message_history`:

```sql
format TEXT DEFAULT ''
```

No `payload_hex` column is added. The existing `retained` and `qos` columns remain authoritative.

Both runtimes add the column through an idempotent schema migration for existing database files. The migration changes only the schema and does not rewrite old rows.

## Persistence Rules

### Received messages

The primary matched subscription determines the stored format. If no subscription supplies a format, use the configured default payload format.

- `hex`: store the MQTT payload bytes as a compact uppercase HEX string in `payload`, without spaces or prefixes.
- `json`: parse the decoded payload; store two-space formatted JSON when valid, otherwise store the decoded payload unchanged.
- `text`: store the decoded payload unchanged.

The persisted `format` is `hex`, `json`, or `text` and represents the actual transformation applied for that history row.

### Sent messages

- When send mode is HEX, store the actual transmitted bytes as a compact uppercase HEX string and persist `format=hex`.
- When send mode is original, store the editor content and persist the editor format (`json` or `text`). Valid JSON is formatted before persistence.

History persistence uses the same encoded byte result that is passed to MQTT publish, so the HEX history value represents the transmitted payload.

## History Query

Keyword search continues to query `topic` and `payload`. Because HEX is stored directly in `payload`, no additional search column is required.

For usability, a HEX-like keyword is normalized by removing spaces and an optional `0x` prefix before matching HEX-format rows. Ordinary text search behavior remains unchanged.

History rows remain ordered by `created_at DESC, id DESC` and use the existing paging index.

## History List

Message history adds an `标识` column between Topic and Payload. It displays compact badges for:

- Direction: `接收` or `发送`
- Retained: `R`, only when `retained=1`
- Format: `JSON`, `TEXT`, or `HEX`
- QoS: `QoS0`, `QoS1`, or `QoS2`

Log history keeps its existing three-column layout. Message and log rows use separate grid definitions so the added message column does not disturb logs.

## History Detail

Message detail uses distinct information levels instead of repeating one serialized message block:

- The first row contains only ID and timestamp.
- The second row contains direction, retain state, format, and QoS badges.
- Topic has its own labelled, wrapping section and copy action.
- Payload has its own labelled, scrollable section and copy action.
- The footer provides `复制完整消息` and `删除记录` commands.

Payload rendering follows the persisted format:

- HEX is displayed as uppercase byte pairs separated by spaces.
- JSON uses its persisted formatted representation.
- TEXT is displayed unchanged.

`复制完整消息` copies the displayed message with its metadata. No separate raw HEX field is needed because a HEX row already stores HEX in `payload`.

## Compatibility

- Old rows with empty or missing format are presented as TEXT.
- New code can read old rows without data conversion.
- Electron and Tauri return the same `format` property in history query rows.
- The change does not alter realtime message rendering or subscription persistence.

## Verification

Automated tests cover:

- Idempotent `format` column migration in Electron and Tauri.
- Received HEX messages persist compact uppercase HEX in `payload`.
- Sent HEX messages persist the actual transmitted bytes in `payload`.
- Valid JSON is formatted before persistence and invalid JSON remains unchanged.
- TEXT remains unchanged.
- History query returns `format` and can find normalized HEX keywords.
- History message rows show direction, R, format, and QoS attributes.
- Old rows with empty format display as TEXT.
- Log history layout remains unchanged.

Manual verification covers receiving and sending HEX, JSON, and TEXT messages, querying a HEX fragment, retained-message badges, and message detail rendering in both desktop clients.
