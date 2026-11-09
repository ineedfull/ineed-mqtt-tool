# 连接配置与运行状态

Electron 与 Tauri 共用连接表单和领域模型。主机仅填写主机名、IPv4 或 IPv6，不包含协议、端口、路径或凭据。IPv6 可用 `::1` 或 `[::1]`；URL 中添加一对方括号，TCP socket 使用不带括号的 IP。

选择 `ws://` / `wss://` 时显示 WebSocket 路径。留空统一访问 `/mqtt`；显式 `/` 访问根路径；`tenant/mqtt?x=1` 会补成 `/tenant/mqtt?x=1`。保存原始配置，编辑时还原；TCP 不使用该路径。路径最多 2048 个 UTF-8 字节，不含空白、控制字符、反斜线或 `#` 片段；需要这些字符时使用 URL 百分号编码。

此前 Electron 空路径访问 `/`、Tauri 空路径访问 `/mqtt`；现在两端统一。如果已有 Electron 服务只接受根路径，请明确填 `/`。没有修改数据库结构、应用 ID、数据目录或用户已有路径字段。

## 实现入口

- `packages/mqtt-contract/src/endpoint.js`：供浏览器表单与 Electron 原生边界共用的主机校验、路径与 URL 构造。
- `packages/domain/src/connectionModel.js`：草稿、表单校验与持久化字段映射。
- `MqttToolShell.vue::saveConnection`：保存前捕获编辑配置，成功后按 ID 查找当前对象，仅回填编辑字段。保存期间收到的状态、计数和诊断由运行事件维护，不用旧快照覆盖；连接参数在下次重连使用。
- `apps/electron/electron/main.cjs`：连接前校验，固定 `transformWsUrl` 保留完整地址，防止 MQTT.js 重构地址时丢掉 IPv6 方括号；路径查询参数不覆盖 MQTT Client ID。
- `apps/tauri/src-tauri/src/mqtt.rs`：Rust 原生校验和 URL/socket 地址处理，遵循同一契约。

## 隔离回归入口

```sh
node --test packages/domain/tests/connectionModel.test.js apps/electron/tests/mqttRuntime.test.js
npm run test:components
npm run build:renderers
node --test apps/electron/tests/connectionEditingSmoke.test.js
npx playwright test -c packages/workbench/playwright.form-layout.config.js
cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml mqtt::tests --lib
cargo build --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --bin mqtt_contract_harness
npm run test:mqtt-contract
```

首次运行原生契约前先构建 harness，避免首次编译超过测试内的构建时限。`mqttRuntimeContractEndpoints.test.js` 在 Electron/Tauri 的真实协议服务上验证 IPv4、裸/带括号 IPv6、默认/根/查询路径、Client ID 隔离、消息收发，以及非法编辑后原连接仍可用。TCP 使用本地 Aedes，WebSocket 使用持续解析 MQTT 分帧的受控回环服务。

桌面测试使用临时 profile 检查创建、连接、编辑、重启恢复。浏览器渲染测试和 Rust 源码契约不能替代 Tauri 原生验收；原生服务回环也不代表完整桌面 GUI 或安装包通过。每轮实际结果记录在工作区任务。
