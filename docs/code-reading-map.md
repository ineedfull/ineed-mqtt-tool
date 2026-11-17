# Current code reading map

Paths below are relative to the repository root. Electron and Tauri render the
same Vue workbench; platform differences live in the renderer adapters and
native entries. Start with one operation, then follow its runtime branch.

## Add, remove or restore a subscription

1. `apps/electron/renderer/main.js` or `apps/tauri/renderer/main.js` creates a
   runtime adapter and passes it to `packages/workbench/src/createWorkbench.js`.
   `packages/workbench/src/runtimeContext.js` exposes that adapter to the shared
   workbench; `packages/workbench/src/workspace/runtimeFacade.js` binds its
   MQTT/database interfaces.
2. `packages/workbench/src/layouts/MqttToolShell.vue` handles `doSubscribe`,
   `removeSubscription` and `copySubscriptionToConnection`. It prepares IDs,
   topic/QoS/display fields, captures a copy target and owns dialog/error state.
   `loadData` applies the pending cleanup snapshot only after load/application
   generation checks. Manual connect and runtime status events trigger restore.
3. `packages/workbench/src/workspace/subscriptionLifecycle.js` owns subscription
   queues, pending timers and offline cleanup persistence. Follow
   `addSubscription` → `subscribeAndPersist`, `removeSubscription`,
   `copySubscription` or `restoreConnectionSubscriptions`. Each method keeps its
   ACK/write/compensation sequence together. Request and status token declarations
   explain when an old connection result becomes invalid.
4. On Electron, `apps/electron/renderer/runtimeAdapter.js` calls
   `apps/electron/electron/preload.cjs`, which invokes authorized IPC in
   `apps/electron/electron/ipcHandlers.cjs` (assembled by `main.cjs`). The native MQTT runtime's `subscribe` and
   `unsubscribe` resolve at their broker callbacks after grant/ACK handling.
   Database handlers call `apps/electron/electron/database.cjs` for subscription
   rows and settings writes.
5. On Tauri, `apps/tauri/renderer/runtimeAdapter.js` invokes `mqtt_subscribe` and
   `mqtt_unsubscribe` in `apps/tauri/src-tauri/src/mqtt.rs`. The manager tracks
   pending commands until protocol acknowledgement. Database commands in
   `apps/tauri/src-tauri/src/database.rs` run writes through the existing database
   service. `lib.rs` registers command entry points.
6. Results return through the adapter to the lifecycle; successful writes update
   the Shell's reactive subscription rows. Runtime connection status callbacks
   reach `handleMqttStatus`, advance status generation and may start restore.
   `packages/domain/src/subscriptionRouting.js` handles received-message filter
   matching and counts; `topicMatcher.js` supplies filter coverage checks.

For ownership, generation invalidation and failure behavior, read
[subscription lifecycle](subscriptions.md). Application operation tracking,
listener disposal, drain, persistence flush and connection shutdown remain in
the Shell's `runTrackedOperation`/`teardown` path.

## Receive and retain a message

Electron's `mqttCoordinator.cjs` batches native reception and calls
`electron/receivedHistory.cjs` before delivering the batch to the renderer.
Tauri's `mqtt.rs::AppHandleEventSink` calls
`database.rs::save_received_messages` before emitting the display event. Both
choose the matching subscription's history format and commit the batch in one
SQLite transaction. Successful delivery includes `historyPersisted: true`;
Electron retries reuse that marker so an event delivery failure cannot duplicate
the saved rows. Native history failures stop normal delivery and prevent a
successful update checkpoint.

The renderer adapters normalize the event through `packages/mqtt-contract`.
`MqttToolShell.vue::processIncomingMessages` updates retained messages, counters
and optional receive logs. It only queues history writes for adapters without the
native commit marker, such as browser previews. Receive logs keep their separate
bounded persistence path.

`workspace/messageViewport.js` calculates retained row offsets and spacers;
`useMessageViewport.js` measures visible rows, selects the viewport and preserves
the reading position when retention removes older rows. Measurements run in the
next animation frame to avoid ResizeObserver delivery loops. `useStreamFollow.js`
owns pause/resume and hidden-page behavior. Filtering and copying still use all
retained records, including rows that currently have no DOM node. The message
container disables browser scroll anchoring because the viewport restores its
own anchor.

Native history tests live in `apps/electron/tests/receivedHistory.test.js`,
`mqttRuntime.test.js` and Tauri database unit tests. Viewport model tests are in
`packages/workbench/tests/messageViewport.test.js`; browser interaction checks
are in `e2e/messageViewport.spec.js`. See the
[desktop soak record](verification/mqtt-desktop-soak.md) for native load evidence.

## Verification entry points

Connection drafts and DB fields are owned by
`packages/domain/src/connectionModel.js`. New drafts use the configured Keep
Alive and Clean Session; edits preserve each connection's saved session setting.
An explicit empty Client ID survives persistence. The Tauri adapter removes DB
aliases before invoking Rust, because edited rows can contain both saved and UI
field names. `stopMqttConnection` checks its connection request token before an
old disconnect result changes UI state or reports an error. Connection dialogs
lock all fields while saving; each new subscription draft reads the current
default QoS.

`apps/electron/tests/connectionEditingSmoke.test.js` checks these drafts and
settings through the production renderer, native MQTT, SQLite and restart.
`apps/tauri/tests/connectionEditingNative.test.js` checks edited-row reconnects
through the adapter and actual Rust service against a local broker. See the
[existing feature acceptance matrix](existing-features-acceptance.md) for the
complete maintenance scope and platform boundaries.

| Concern | Existing tests / command |
| --- | --- |
| UI wiring, ordering, rollback, offline retry and old/new connection ACK races | `packages/workbench/tests/components/mqttToolShell.vitest.js`; root `npm run test:components` |
| Native Electron IPC, SQLite and persistent-session cleanup through restart | `apps/electron/tests/subscriptionsSmoke.test.js`; build Electron renderer, then root `npm run test:electron:subscriptions` |
| Electron native MQTT acknowledgements and session safety | `apps/electron/tests/mqttRuntime.test.js`; root `npm run test:electron` |
| Shared protocol and persistence contracts | `packages/test-contracts/tests/mqttRuntimeContract*.test.js`, Electron database compatibility tests, Tauri MQTT/database contract tests; root `npm test` |
| Adapter forwarding and boundaries | `apps/{electron,tauri}/tests/runtimeAdapter.test.js` and boundary tests; root `npm test` |
| Browser subscription interactions, themes and layouts | `packages/workbench/e2e/subscriptionChat.spec.js`, `desktopLayout.spec.js`; root `npm run test:e2e` |

Run root `npm run lint` and `npm run build:renderers` for shared source changes.
Browser tests and shared component tests cover common UI logic. Native Electron
and Tauri desktop/installer verification have separate runtime gates in README;
configured Windows/Linux targets do not establish native acceptance.

## 时间显示

时间 formatter、历史兼容与显示/存储边界见[时间显示规则](date-time-display.md)。新增界面时间先复用该入口。

## 模块边界与状态归属（2026-11-17）

Electron 的 `apps/electron/electron/main.cjs` 是组装入口，保留原有测试所用导出。
`windowManager.cjs` 拥有主窗口/历史窗口与受信任页面集合；`closeLifecycle.cjs`
拥有关闭握手、超时及幂等退出；`mqttCoordinator.cjs` 拥有连接事件与接收落盘协调。
`ipcContract.cjs` 声明通道和参数边界，`ipcHandlers.cjs` 注册和校验调用；
`updateCheck.cjs` 检查更新清单及外链，`smokeRuntime.cjs` 管理隔离启动标记。
它们由入口注入依赖，不反向加载入口，也不重复注册生命周期监听。

共享 Shell 继续拥有连接草稿、订阅、收发与应用资源。`components/ConnectionDialog.vue`、
`SettingsDialog.vue`、`AboutDialog.vue` 只负责呈现、字段绑定和事件；设置丢弃确认与保存
仍回到 Shell。`workspace/updateWorkflow.js` 拥有更新状态和单次准备任务，调用 Shell
提供的准备函数；停止场景/定时发布、断连、刷新视图与持久化 flush 的顺序仍集中在该函数。
旧异步结果继续使用 Shell 的 operation generation 校验。

Tauri 的 `src-tauri/src/mqtt.rs` 保留会话、批次、ACK 与重连生命周期；`mqtt/config.rs`
负责校验和连接选项构造，`mqtt/diagnostics.rs` 分类错误与重试决策。数据库连接与写入仍由
`database.rs` 拥有，`database/schema.rs` 保留完整 SQLite 语义比较算法。两个 `tests.rs`
为原有单元测试的外部模块，不编译进生产逻辑。

`styles/base.css` 是有序入口，`styles/base/` 按主题/外壳、侧栏/弹窗、消息、发送、辅助/历史
分段；全部仍在原来的 `legacy` layer 中。调整顺序会影响 cascade，应作为行为变更评估。

## 设备消息场景

`ScenarioPanel.vue` → `readScenarioDraft` → `messageScenario.js::normalizeScenario/prepareScenario`，保存交给 `scenarioRepository.js` 的串行队列。`load`与所有写入共用队列；内存只发布完整已验证快照，写入失败保留上次提交。文件导入通过同步文本监听失效旧预览，以修订号丢弃迟到读取。

执行由 `scenarioRunner.js` 接收草稿和当前连接，经 `withResponseSubscription` 确认响应订阅后发布。`acceptMessages`逐项过滤来源、retained、旧时间、UTF-8、JSON和requestId，再做断言；`finishRun`冻结业务结果，订阅释放完成后才释放runner占用。停止不撤回已发布指令。报告保存回同一repository队列，公开场景/报告格式未变。

对应 `scenarioRepository.test.js`、`scenarioRunner.test.js`、组件 `scenarioPanel.vitest.js` 与 `e2e/scenarios.spec.js`。本轮边界与回归见[可读性审查](reviews/2026-11-02-readability.md)。
