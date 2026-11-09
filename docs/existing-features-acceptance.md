# MQTT Tool 现有功能检查与修复验收

检查日期：2026-10-12。沿用现有功能，检查输入、保存、会话身份、设置接线与持久化边界；Electron/Tauri 继续共用工作台和领域模型。

## 功能检查矩阵

| 现有功能 | 检查重点 | 回归入口（相对于仓库根目录） |
| --- | --- | --- |
| 连接新建、编辑、克隆、删除 | 原始数值校验、Client ID 回显/清空、保存锁定、失败恢复、删除后的迟到结果 | `packages/domain/tests/connectionModel.test.js`、`packages/workbench/tests/components/mqttToolShell.vitest.js`、`apps/electron/tests/connectionEditingSmoke.test.js` |
| 连接、断开、自动重连 | 请求身份、断开完成晚于新连接、状态/订阅恢复、原生别名兼容 | 上述 Shell 测试、`apps/tauri/tests/runtimeAdapter.test.js`、`connectionEditingNative.test.js`、`apps/electron/tests/mqttRuntime.test.js`、`packages/test-contracts/tests/mqttRuntimeContract*.test.js` |
| 订阅、取消、复制 | ACK 后保存、失败补偿、重叠过滤器、离线清理、持久会话重启、默认 QoS | Shell 组件测试、`apps/electron/tests/subscriptionsSmoke.test.js`、`packages/domain/tests/subscriptionCoverage.test.js`、`subscriptionRouting.test.js` |
| 发布、定时发送、编辑器 | UTF-8/HEX、JSON 草稿、复制、QoS/Retain、失败和停止、控件可见性 | `packages/workbench/tests/publishWorkflow.test.js`、`mqttPayloadIntegration.test.js`、`payloadEditorState.test.js`、Shell/PayloadEditor 组件测试、`e2e/composer.spec.js` |
| 实时消息、日志、详情 | 原始载荷、过滤、方向、跟随、显示上限、订阅归属 | `packages/workbench/tests/messageFilters.test.js`、`messageInspector.test.js`、`realtimeItems.test.js`、`packages/domain/tests/subscriptionRouting.test.js`、`packages/workbench/e2e/subscriptionChat.spec.js` |
| 历史、存储、迁移 | 历史查询/删除、批量落盘、退出排空、旧配置/数据库兼容、失败反馈 | `packages/workbench/tests/batchedPersistence.test.js`、`storageStats.test.js`、historyWindow 组件测试、`packages/test-contracts/tests/databaseCompatibility.test.js`、Electron/Tauri 数据库合同测试 |
| 设置、主题、大字、侧栏、弹窗 | 默认值实际消费、保存队列、浅/深主题、普通/大字、展开/折叠、960/1120/1440 宽度 | `packages/workbench/tests/settingsModel.test.js`、`settingsPersistence.test.js`、Shell/导航/焦点组件测试、`packages/workbench/e2e/typography.spec.js`、`desktopLayout.spec.js`、`editorChrome.spec.js` |
| 检查更新、关于、外链 | 当前检查接口、清单解析、链接约束及错误显示 | 更新合同测试、`packages/workbench/tests/updateUrl.test.js`、Shell 组件测试、`packages/workbench/e2e/about.spec.js` |

矩阵是维护与复跑入口。更新检查已有实现与公开发行、自动下载安装分别验收；本轮未修改发行清单或公网服务，不能由本地合同通过推定线上升级完成。

## 已确认并修复的 7 类问题

1. **连接数值草稿校验不完整。** 端口小数、Keep Alive 小数或空值可能进入保存；现在保存前要求端口 1–65535、Keep Alive 10–3600 的整数。有效数字字符串仍兼容，空值、非数、布尔值和数组被拒绝。
2. **连接保存期间还能编辑草稿。** 原先只有名称锁定，其他字段的修改会被旧保存完成关闭丢弃；现在保存时锁定所有输入和协议选择，失败后沿用原恢复流程。
3. **旧断开结果覆盖新连接。** 原生可先通知已断开，再完成资源停止；此间快速重连后，旧 Promise 的成功/失败仍可能修改状态或显示旧错误。现在两条完成路径都核对该连接的请求身份。
4. **已保存 Client ID 回显/清空错误。** 草稿未读取 `client_id`；显式清空又因 `||` 恢复旧值。现在使用空值回退，保存为空字符串并在重启后保持为空。
5. **Tauri 编辑连接后无法重连。** 数据库行和编辑草稿合并产生 `client_id`/`clientId` 等重复字段，Rust serde 拒绝解析。Tauri adapter 在调用边界保留一套 UI 字段，显式空字符串、false 和 0 不丢失；SQLite 格式与输入对象保持兼容。
6. **Clean Session 设置没有用于新连接。** 新建草稿现在采用已保存设置，落库为整数 0/1；编辑继续保留该连接已有会话值。
7. **新订阅没有采用默认 QoS。** 每次打开添加订阅采用当前默认值，用户仍可手动选择其他 QoS；发布原有默认设置行为继续适用。

数字校验、保存锁、旧断开成功/失败、Client ID、别名与两处设置均有修复前失败、修复后通过的专项证据。默认设置原本为 QoS 1；以 QoS 0 验证 ACK/补偿的旧用例现在明确选择 0，保留原断言。

## 本轮验证

| 命令 | 结果 |
| --- | --- |
| `npm test -- --test-concurrency=1` | 537/537，0 失败、0 跳过；包含真实 Electron、Rust 服务、协议及数据库合同 |
| `npm run test:components` | 95/95，8 个测试文件 |
| `npm run lint` | 通过，0 warning 门禁 |
| `npm run build:renderers` | Electron/Tauri renderer 构建通过；现有 chunk 大小提示保留 |
| `cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml` | 69 项通过（库 67、关闭测试入口 1、MQTT harness 1） |
| `npm run test:e2e` | 28/28，Electron Chromium 浏览器预览 |
| `npx playwright test -c packages/workbench/playwright.typography.config.js` | 68/68，Electron/Tauri 预览 × Chromium/WebKit；主题、字号、侧栏、窄窗口、订阅和发送区 |
| `node --test apps/electron/tests/connectionEditingSmoke.test.js apps/tauri/tests/connectionEditingNative.test.js` | 2/2，实际 Electron/SQLite/重启与 Tauri Rust 本地 Broker 编辑重连 |
| `git diff --check` | 通过 |

独立复核生产差异通过，并补跑模型/adapter 27 项、Shell 66 项。复核指出新测试应先关闭应用再删除 profile，已调整清理顺序。新桌面用例开发时纠正过控件名称和离线订阅前提，最终采用实际本机 Broker 验证订阅 QoS 落库。

本轮环境为 macOS arm64，隔离 profile/SQLite，网络仅本机回环。Electron 用例加载生产 renderer、受限 preload 与主进程，验证输入拒绝、设置、订阅持久化、Client ID 清空与重启；Tauri 新用例经真实 adapter/serde/Rust MQTT 服务连接本机 Broker，持久化行与编辑草稿使用真实领域转换组合。

Tauri 浏览器预览与 Rust 服务验收分别记录，不代表完整 Tauri 原生桌面 GUI。Windows/Linux、macOS x64 实机、实体 Broker、安装包与公网更新仍需对应环境验收。此前旧参考视觉门禁差异沿用历史记录，本轮没有替换参考基线。没有打包、上传或发布。
