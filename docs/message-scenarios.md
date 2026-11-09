# 设备消息场景测试

Electron 与 Tauri 共用「场景测试」工作区。它验证设备对一条 JSON 指令的业务回复，复用当前连接，不要求新的 MQTT 协议版本。MQTT 的发布确认仅表示协议层进度，只有关联响应满足全部业务断言才会通过。

## 使用

1. 在连接列表选择并连接测试 Broker，进入「场景测试」。默认示例发布到 `devices/unit-1/command`，等待 `devices/unit-1/response`。
2. 设置名称、具体的发布/响应主题、JSON 载荷模板、变量对象、请求/响应关联路径和超时。变量值都是字符串；模板中使用 `{{device}}`、`{{requestId}}`，载荷中的变量放在 JSON 字符串内。变量替换会转义 JSON 字符串。
3. 每次执行自动生成唯一请求 ID，并强制写入指定请求路径。设备必须在响应的同一路径原样返回该字符串。例如请求 `{"requestId":"…","command":"read"}`，响应 `{"requestId":"…","status":"ok","temperature":25}`。支持 `data.requestId`、`items.0.id` 这样的简单点路径，拒绝原型字段和脚本。请求关联路径的中间节点须为对象；数组数字索引主要用于响应读取与断言。
4. 通过表单添加 equals（JSON 标量严格相等）、type（string/number/boolean/object/array/null）和 range（有限数值、含上下界）断言。字段缺失、类型错误或越界均不能通过。
5. 保存场景以便再次使用；修改后保存自动递增版本。执行当前草稿也会保存完整快照，之后修改场景不会改写旧报告。场景导入先预览、再确认，以新 ID 保存副本；删除场景保留历史报告。
6. 执行时等待真实响应订阅确认后发布；默认不设置发布 Retain。结果包括通过、失败、超时、停止或连接中断。可导出已保存场景库和单次结果 JSON：展示完整 JSON 并通过现有原生剪贴板复制，内容可保存到文件或直接粘贴导入。Electron 另提供 JSON 文件下载；Tauri 首版不提供原生另存为文件，不能用 WebKit 浏览器下载结果冒充该能力。

超时为50～300000毫秒，覆盖订阅排队、确认、发布和等待。一次仅执行一个场景，直至该轮订阅清理结束。停止立即结束业务判定，但不能撤回已经发出的指令；原生订阅请求尚未确认时，页面会继续显示等待清理，迟到确认只参与清理，不会发布。

## 证据与存储

报告记录本轮/请求 ID、连接 ID/名称、场景及变量快照、实际发送主题和 JSON、发布/接收/结束时间、收到的原文与原始十六进制、Retain、匹配或忽略原因、每条断言的实际值和结论。终态后不再处理消息；订阅清理状态和保存错误可随后补充，不能改变业务结论。无效 UTF-8/JSON、其他连接、错误 ID、发布前消息、旧时间戳和 Retain 回复不能证明本轮通过。断连终止本轮，自动重连不会继续旧执行。

证据最多64条、每条64KiB、原始载荷累计256KiB，超额记录省略计数；匹配响应单独保留，所以前面的无关消息不会挤掉业务依据。超过64KiB的响应不参与判定。场景库最多100项/2MiB；报告最多30份/16MiB，按最近执行保留。时间存储为原时间戳，界面复用集中格式化入口显示本地 `YYYY-MM-DD HH:mm:ss.SSS`。

复用现有 settings 表的 `mqtt.scenarios.v1`、`mqtt.scenarioReports.v1`，没有 SQLite schema、应用 ID、数据目录或原有历史迁移。保存失败保留草稿并显示错误；报告写入失败也明确显示。导出只包含场景/报告白名单字段，不包含连接地址、用户名、密码或 TLS 配置。用户自己录入的变量和业务载荷仍包含在导出中，应按实际业务数据保管。

## 订阅所有权

场景使用现有连接的订阅队列，在执行和清理期间，该连接新增/删除/复制订阅会排队；其他连接不受影响。已有完全相同的响应主题时，使用其原 QoS 确认并借用，结束时不取消用户订阅。其他过滤器保持原样。

新临时主题先写入既有 `mqtt.pendingUnsubscriptions.<connection ID>` 清理意图，再发送 SUBSCRIBE。正常结束等待 UNSUBACK 再清除意图。停止后的迟到 SUBACK 会清理同一连接代际的临时主题；连接代际已变化时不操作新 socket，清理意图留待既有重连恢复流程。清理 ACK 失败保留意图并显示重试信息；重连若发现同名用户订阅，则保护它而不是发送 UNSUBSCRIBE。

入口：领域模型 `packages/domain/src/messageScenario.js`、执行器 `packages/workbench/src/workspace/scenarioRunner.js`、持久化 `scenarioRepository.js`、生命周期 `subscriptionLifecycle.js` 的 `withResponseSubscription`、界面 `components/ScenarioPanel.vue`。Shell 仅组装服务、转发原始消息/状态并在关闭/更新前停止执行。

## 验证与边界

专项命令：

```sh
node --test packages/domain/tests/messageScenario.test.js packages/workbench/tests/scenario*.test.js
node --test packages/test-contracts/tests/mqttScenarioContract.test.js
npm run test:components
npx playwright test -c packages/workbench/playwright.scenarios.config.js
npm run lint
npm run build:renderers
```

首轮实现的真实回环 Broker 验证使用 Electron 生产 MQTT coordinator 与 Tauri Rust MQTT harness，覆盖正确/错误回复、无回复、停止、真实保留消息标记和用户订阅存活；所有连接、服务和隔离内存设置在结束后清理。双渲染入口 Chromium/WebKit 覆盖浅深、普通/大字、展开/折叠、1440/920宽窗及业务结果导出。这部分分别属于原生服务验证和浏览器工作台验证；后续真实桌面验收见下文，安装包与其他平台仍需单独验证。

真实桌面专项验收使用既有隔离 Electron 主进程与显式启用的 Tauri `desktop-soak` 宿主，直接操作生产 renderer 的 DOM。命令如下；`SCENARIO_OUT` 必须指向本轮独立结果目录，测试资料留在独立 `/tmp/mqtt-scenario-profiles-*`，不读写用户连接和历史。

```sh
npm run build:renderers
TAURI_CONFIG='{"build":{"devUrl":null}}' cargo build --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --features desktop-soak --bin desktop_soak_harness
SCENARIO_OUT=/tmp/mqtt-scenario-acceptance node tooling/desktop-soak/scenarios.mjs
SCENARIO_OUT=/tmp/mqtt-scenario-acceptance node tooling/desktop-soak/scenarioRestart.mjs
```

默认两端各持续1200秒负载、随后同进程静置180秒。循环业务通过/失败/超时/停止、错误ID与迟到重复响应、保留消息和手动断连恢复；每轮检查真实订阅清理意图和落库报告。预检实际点击JSON导出和原生复制，逐字读回、粘贴场景库预览并导入独立副本；Electron另通过真实session下载回读文件。剪贴板测试开始保存所有原生格式、结束恢复；与其他需要全局剪贴板或保存面板的验收串行运行。完成后单独重新启动两个桌面进程，核对场景库、30份报告ID及最后原始证据。

`desktop-preflight.json`、`progress.json`、`idle.json`、`sqlite.json`、`result.json`和`process-restart.json`分别记录操作、采样和一致性证据；只有实际时长达到要求且结果断言通过才计入完成。原生窗口保持可见，Tauri的WebKit XPC资源与主进程分别记录，同机并发其他工具时不能把全部WebKit进程归到本产品。此入口仍是源码桌面测试宿主，不是安装包验收。

2026-11-01 macOS arm64实际双桌面验收完成：monotonic负载1201.037秒、同进程静置180.057秒，两端各6162次正式场景（另各1次预检），业务通过各2054次，预期业务失败/超时/停止/连接中断各1027次，非预期错误0。原生JSON导出/剪贴板/原样场景导入、Electron原生文件下载、SQLite quick_check、30份报告保留和双端全新桌面进程恢复通过。第一段256秒运行因其他窗口完全遮挡Tauri而终止，未计入正式时长；重跑沿用既有置顶测试策略并协调其他工具的可见区域。

该轮共享349、Electron143、Tauri49、场景专项23、组件112、浏览器矩阵68及lint/双renderer构建通过。Electron进程组RSS负载末498.5MiB、静置末406.3MiB；Tauri native95.2→103.6MiB，其专属WebKit243.9→202.3MiB。资源会随阶段波动，这次有限时长没有证明长期不存在增长。测试进程、Broker与套接字均关闭，全部剪贴板格式恢复；未进行安装包启动或Windows/Linux/IntelMac实机验收，也未打包、上传或发布。

首版响应主题为具体主题，不支持通配符。只支持 JSON 字符串请求 ID 关联和上述断言，不执行任意脚本，不提供 MQTT 5 Response Topic/Correlation Data、历史回放、心跳或 Will。场景请求使用现有连接真实发布，测试应使用已确认的设备和目标。
