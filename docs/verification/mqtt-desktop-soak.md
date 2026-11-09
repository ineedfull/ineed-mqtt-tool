# MQTT 原生桌面持续运行验收

日期：2026-10-12/13。范围：macOS arm64，48 GiB，Node 26.10.0，Electron 43.1.0，Tauri/WKWebView。最初测试开始代码为 `dce1beb`；后续压力遗留修复起点为 `7dfc7c9`，保留应用内更新的已有未提交改动。本页按轮次保存历史证据，较早段落中的待写队列限制及未采用原生落盘描述是当时状态。没有发布或打包，不访问现场网络。

## 测试入口与隔离

- `tooling/desktop-soak/run.mjs` 同时启动真实 Electron 桌面和 Tauri 原生 WebView，使用一个仅监听 `127.0.0.1` 的鉴权 Broker、两个临时 SQLite/profile。
- Electron 复用 `apps/electron/tests/fixtures/clipboardHarness.cjs`，直接加载生产主进程、沙箱 preload 和生产 dist，通过 Playwright 访问窗口。
- Tauri 使用新增测试 binary `apps/tauri/src-tauri/src/bin/desktop_soak_harness.rs`，以独立应用 ID 创建原生窗口、嵌入生产 dist、启用原 clipboard plugin，并从生产 `main` 窗口配置构建（包括后台节流策略）。全部数据库和 MQTT handler 引用 `ineed_mqtt_tool_lib::{database,mqtt}`，没有复制协议实现或修改生产 capabilities。生产 Vue 使用原 Tauri adapter；测试监测额外通过 `__TAURI_INTERNALS__.invoke` 和原事件监听读取状态。
- 连接、QoS 1 订阅、断开、重连、非法端口、主题、大字模式和侧栏操作由生产 DOM 触发。历史查询和最终清理使用真实原生数据库调用。消息 payload 含 JSON、中文及 `<svg onload=alert(1)>` 文本。
- `SOAK_SECONDS` 默认 1200，`SOAK_RATE` 默认 500。连续保留同一桌面进程；每分钟暂停发布、等待落盘、执行上述动作，再恢复发布。不把循环重启算作持续运行。

复现：

```sh
TAURI_CONFIG='{"build":{"devUrl":null}}' cargo build --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --features desktop-soak --bin desktop_soak_harness
SOAK_SECONDS=1200 SOAK_RATE=500 SOAK_IDLE_SECONDS=180 SOAK_HIDE_TAURI=1 node tooling/desktop-soak/run.mjs
```

桌面资源验收保持两端窗口可见，并在完成后留给用户观察：

```sh
SOAK_SECONDS=1200 SOAK_RATE=500 SOAK_IDLE_SECONDS=180 SOAK_HIDE_TAURI=0 SOAK_EXPECT_VISIBLE=1 SOAK_KEEP_WINDOWS=1 node tooling/desktop-soak/run.mjs
```

测试宿主将两窗口放到屏幕两侧，并在可见模式置前，避免一个完全遮住另一个；每分钟断言两端 `visibility=visible` 且工作台有实际宽度；另记录 `visibilitychange`，负载接收期间不允许转为隐藏状态。`SOAK_KEEP_WINDOWS=1` 保留两个隔离桌面窗口供观察，通过或失败均不自动关闭窗口。通过后断开连接和清理测试历史；退出测试流程时关闭 Broker。此时 driver 因窗口仍开着而继续运行，不能将它报告为退出码 0；通过依据为 `result.json` 的 `passed=true` 和 `cleanup` 中网络资源归零。手动关闭窗口或结束 driver 是后续操作。

测试 binary 由显式 `desktop-soak` feature 开启，普通 cargo/发行构建不生成该宿主。

需要预先存在当前 `apps/electron/dist`、`apps/tauri/dist`。最小预跑可使用 `SOAK_SECONDS=10 SOAK_RATE=50`；两端预跑已完成 500 条事件/落盘/清理及分钟动作校验。每次自动创建 `/tmp/mqtt-desktop-soak-*`，保留数据、样本、截图与 native 日志供复查，不删除用户 profile。

## 证据口径

每分钟记录发送数、独立原生事件监听的接收数、序号缺失/重复/无效 payload、SQLite 历史总数、原生存储字节数、DOM 保留消息数、主题/字号和 renderer errors。100ms 定时器记录超过 200ms 的额外延迟；这只测事件循环心跳，不代表点击延迟的完整分位数。每次启动预先注册错误与未处理 Promise 拒绝监听。

RSS/CPU 使用 `ps -axo pid=,ppid=,%cpu=,rss=,comm=`，Electron 为主进程及其全部后代 RSS 之和。Tauri 宿主单列；WebKit 的 XPC 进程父 PID 为 1，另外记录启动前后新出现的 WebKit PID，作为本次窗口的对应进程估计，并保留系统 WebKit 全表。没有把宿主 RSS 与 Electron 全树直接比较，也没有把全部系统 WebKit 算到 MQTT。CPU 为 `ps` 的进程百分比样本，多进程求和可以超过 100%，不作为瞬时延迟或完整平均负载。RSS 求和可能重复共享页，不等于物理独占内存；Node driver、Broker、publisher 和其它产品测试不计入此桌面表。

## 缺陷与失败证据

真实本机 Broker 复现非法 `bad/#` QoS 0 发布：Electron 原返回成功，随后连接被 Broker 关闭。现在 Electron 主进程和共享发布流程在发送前拒绝通配符、控制字符及超长 UTF-8 Topic；双端每种非法输入后仍能发布并收到合法 sentinel。Tauri 原有原生校验正常。

共享落盘队列的 `flush()` 在 drainer 未结束时为每次调用建立新的等待 Promise；阻塞写入再持续入队 1,000 次的回归复现 1,000 个等待。现在共用同一个排空 Promise，并保留排空完成窗口新消息必须写入的行为。该回归只证明等待队列缺陷已修，不等于证明全部 WebView 问题已解决。

原 20 分钟长跑 UTC `2026-10-12T13:08:32.607Z` 开始，目录 `/tmp/mqtt-desktop-soak-rdWarQ`，日志 `/tmp/mqtt-desktop-soak-long.log`。每端收到 566,800 条，序号缺失/重复/非法 payload 为 0。Electron 全部落盘；Tauri 只保存 499,400 条，欠 67,400 条。WebKit 关联 RSS 最高约 3.3 GiB；静置 36 秒后原 WebContent PID 消失、出现新 PID，driver 启动时间改变、接收数归零，明确是 WebView 重载，不能把 RSS 下降解释为正常 GC。最终测试 Broker 套接字为 0，但验收失败。

修队列后第一轮 `/tmp/mqtt-desktop-soak-c7LYvD` 在约 7 分钟再次重载；第二轮 `/tmp/mqtt-desktop-soak-In1ytE` 在 3 分钟查询时落盘暂欠 600 条，因旧固定等待 1.2 秒的门禁停止，不能据此判定这 600 条永久丢失。失败运行保留，未冒称成功。测试宿主经历普通 `cargo test` 重建后也暴露重复创建 `main` 窗口的问题，宿主现主动清除默认窗口并固定测试应用 ID，正式产品入口未改。

性能采样记录 WebKit 主线程主要在消息区布局；短动画对照最初同时存在窗口可见性差异，不能用它直接归因。显式隐藏窗口后，原样发送 29,900 条，仅落盘 24,200；关闭动画发送 29,800 条，仅落盘 21,800。停流量后最多 10 秒排空仍不一致，因此动画假设被否定。

第三项缺陷与隐藏页面的布局有关。WebKit 性能采样中主线程大部分时间消耗在布局；仅关闭动画、暂停跟随、改走 SDK 备用 IPC 通道或隐藏消息列表，都未消除落盘缺失。完全停止不可见工作台的布局后，2 分钟对照发送 58,200 条，两端全部保存，WebKit 关联 RSS 约 262 MiB。

布局缓解使用 Page Visibility 状态控制共享工作台根节点的 `v-show`：隐藏时保留 Vue 实例、消息处理、连接及落盘，仅停止不可见界面的布局；自动跟随也不读取隐藏页面的滚动尺寸。回到前台后恢复布局，并在 Vue 更新完成后继续跟随最新消息；用户手动暂停跟随的状态保留，卸载时移除监听。组件失败回归确认旧实现隐藏时仍读取布局，新实现不读取。

生产 Tauri `main` 另外配置 `backgroundThrottling: "disabled"`，测试宿主继承此配置。官方依赖说明默认隐藏窗口可能限制定时器或卸载 view；该配置单独使用时仍出现历史缺失，因此不能作为完整修复的证据。该选项在 macOS 14+ 生效，本轮实机为 macOS 27.0.1；较早 macOS、Linux/Windows 未验收。没有把诊断动画、备用 IPC 或原生落盘改造纳入产品。

布局修复后的首次正式复跑 `/tmp/mqtt-desktop-soak-JYx8Kx` 与重型原生全量测试同时运行，第一分钟发送 29,900 条、仅保存 29,100 条，Tauri 保存 IPC 最大耗时 2,977ms，最终门禁失败。2000 行有界待写队列仍存在：持续写入赶不上收包时会丢弃旧行，不能承诺任意压力下历史完整。本轮不扩大队列来掩盖失败，保留该样本作为更强并发下的限制；当前复跑避免额外重型负载，以验证明确的 500 条/秒双桌面场景。

## 校验与资源压力

双端真实恶意 Broker 分别发送保留包类型、非法 Remaining Length、截断 PUBLISH、8 MiB + 1 字节载荷，8 个场景都被拒绝，随后用同一原生服务重连鉴权 Broker、订阅并发布 sentinel 成功。Tauri 对非法包可能报告带诊断的 `offline`，测试允许该原有状态语义。

Node 串行回归 544/544、组件 96/96、lint、双 renderer 构建、测试原生宿主构建及 Rust fmt 通过。浅/深色、普通/大字、侧栏展开/折叠和窄窗口浏览器布局 10/10，双运行时 Chromium/WebKit 字号与工作台矩阵 68/68 通过。原生服务突发压力每端 100,000 条、8 连接 × 10 topics、1 KiB 载荷；目标 100,000 条/秒的饱和入口实测 Electron 17,039 / Tauri 11,035 条/秒，0 重试、0 drop、最大持久化批次 200。这是 native service/SQLite 门禁；Electron 由 Node harness 承载，没有桌面 GUI，RSS 包含 Broker/消息账本/runner，不能当作产品独占内存。

隐藏窗口正式复跑 `/tmp/mqtt-desktop-soak-FkARaT` 已通过：20 分钟负载 1,204,363ms，加 3 分钟静置与前台恢复，总计 1,389,381ms。每端收到并保存 562,100 条，序号缺失/重复/无效 payload 和页面异常均为 0；Tauri 同一页面及同一组 WebKit PID 持续运行。SHOW 后窗口可见、工作台宽度 1360，DOM 最新序号 562,100；历史清理后计数为空，Broker 套接字 0、服务关闭，driver 退出码 0。目标 500 条/秒，包含每分钟动作及暂停后的实际均值约 466.7 条/秒，落盘追平耗时 1,787–3,145ms。精简统计见 [隐藏场景 JSON](mqtt-desktop-soak-hidden-2026-10-12.json)。

该场景 Electron 可见、Tauri 隐藏，不能作为两端可见窗口的资源比较。Electron 全树 RSS 首次/峰值/负载最后/静置最后为 788.1/895.7/879.5/768.9 MiB；Tauri 宿主 142.5/143.6/108.8/108.7 MiB，关联 WebKit 247.7/309.5/293.0/286.7 MiB。没有 WebView 重载，但有限样本不证明无泄漏。

用户要求桌面窗口均可见后，新增 `/tmp/mqtt-desktop-soak-c6roYK` 的双端可见验收。前 3 分钟 87,300 条全部保存，两端 `visibility=visible` 且工作台宽度 1120；第 4 分钟每端收到 116,000 条，Tauri 只保存 113,500 条，停止发布超过 10 秒后仍欠 2,500。保存 IPC 最大 839ms，历史保存调用累计仅提交 113,500 行，表明不能用隐藏场景的通过宣布整体缺陷已修复。该运行提前失败，不能算作可见窗口 20 分钟验收。首次调整窗口位置的脚本在 Electron 窗口未创建时调用 `setBounds`，导致启动失败（`/tmp/mqtt-desktop-soak-i3egdm`）；已改为先等真实窗口出现。该错误来自测试启动顺序，未修改产品窗口逻辑。停止发布后给 SQLite 最多 10 秒排空，逐分钟要求原生接收数和历史总数都等于发送数；记录实际排空等待时间，不通过任意增加消息缓存掩盖丢失。静置阶段检查启动标识、接收数、历史及 renderer 错误，最终断开并清理测试历史。

## 边界

Tauri 为测试宿主下的生产 renderer/native commands 验收。宿主未覆盖生产私有 window/update/lifecycle 模块，退出用测试宿主 `app.exit`；不能据此宣称生产安装包 GUI、关闭握手、自动更新、外部链接或历史独立窗口通过。历史数据查询与落盘在此覆盖，历史独立窗口另由生产门禁负责。未增加屏幕/辅助访问权限，Tauri 没有截图或人工点击验收。

Electron 采样截图可见恶意标记按文本展示；窗口由 Playwright 管理。本轮没有 Windows/Linux、macOS x64 或正式签名安装包验收。20 分钟流量与 RSS 样本只能说明该时段表现，不能推断无限运行。

原首轮 Electron 在 Topic 修复前已启动，属于修复前启动版本；Topic 修复由重新启动的真实 Broker 合同测试验收。

## 锁屏诊断与解锁后的可见验收

本轮跨 2026-10-12/13 午夜继续。后续动画诊断 `/tmp/mqtt-desktop-soak-eHmXcf`、`uFkUlN`、`bFr8zm` 在可见性门禁失败：原生窗口报告可见、未最小化，但 WebView 报告隐藏，因此这些结果不能作为可见场景或动画效果的证据。窗口原生坐标与系统窗口表也确认在屏幕范围内。

继续核对 CoreGraphics 会话字典后确认 `CGSSessionScreenIsLocked=1`、控制台会话未打开，系统窗口表中 loginwindow 覆盖显示器；锁屏会让 WebKit 进入隐藏状态，显示/聚焦窗口无法解锁会话。这解释后续可见性门禁失败，不抵消此前真实历史缺失。没有尝试输入密码或改变系统锁屏设置。

用户解锁后核对系统会话确认为未锁屏，再运行有效的 5 分钟动画对照 `/tmp/mqtt-desktop-soak-3ycM0Y`：仅测试注入 `.chat-msg { animation: none !important; }`，每端 144,800 条收到并完整保存，加 1 分钟静置，总计 365,619ms；页面异常、序号缺失/重复/无效 payload 均为 0，清理后历史为空。这支持减少逐条动画开销的方向，不能断言动画是所有失败的唯一原因。

随后生产 CSS 移除消息行 `chatIn` 入场动画及其无用 keyframes；保留其它动画、有界队列和原生 IPC。双 renderer 与原生宿主重建、lint、布局 10/10 通过后，于 UTC `2026-10-13T03:12:04.470Z` 启动正式可见长跑 `/tmp/mqtt-desktop-soak-ZpNg0Y`。该运行没有诊断 CSS 注入，完成 20 分钟负载（1,202,824ms）加 3 分钟静置，总计 1,390,072ms，每端 572,900 条完整接收/保存，缺失/重复/无效 payload/页面异常为 0；页面启动标识未改变，所有负载与静置样本均可见且无隐藏切换。`result.json passed=true`，测试历史清空，Broker 套接字 0、服务关闭；两端清理后的数据库 `quick_check=ok`。窗口按要求保留，driver 因窗口仍开着未退出，不能报告为退出码 0。目标 500 条/秒，含每分钟动作与暂停后的实际均值 476.3 条/秒；落盘追平 908–1,523ms，Tauri 保存 IPC 最大 61ms。精简统计见 [可见场景 JSON](mqtt-desktop-soak-visible-2026-10-13.json)。

可见模式用临时 `caffeinate -di -w <driver PID>` 防止测试期间自动熄屏，测试收尾结束该断言，不解除已有锁屏或改系统偏好。

用户核对窗口标题后，Tauri 正式配置与 Electron 主窗口标题统一为 `iNeed MQTT Tool`，测试宿主移除自定义测试标题、继承正式标题。首次窗口配置两端均为 1360×860，最小 1120×720；本轮为并排观察调整到约 1120×800。窗口尺寸按桌面逻辑像素解释；Electron 创建参数是外框尺寸，Tauri 配置是内容尺寸，不能据此声称内容区域像素完全相同。运行中的长跑保持原进程，不因标题变更重启。应用 ID、用户目录与发行文件命名未改变。


## 可见长跑资源结果与后续风险

| 进程组 | 首次负载 RSS | 峰值 RSS | 负载结束 RSS | 静置结束 RSS |
| --- | ---: | ---: | ---: | ---: |
| Electron 全进程树 | 720.2 MiB | 835.5 MiB | 834.3 MiB | 732.8 MiB |
| Tauri 宿主 | 146.3 MiB | 148.8 MiB | 148.8 MiB | 148.7 MiB |
| 关联 WebKit 进程 | 497.2 MiB | 1,425.1 MiB | 1,425.1 MiB | 1,424.6 MiB |

三组暂停采样的 CPU 百分比范围分别为 34.9–91.8、10.0–21.1、4.5–44.6。它们不是持续发布期间的平均 CPU，不能据此给出双端性能排名。

本轮目标负载下的数据完整性已通过，资源问题没有全部排除：可见 WebKit RSS 随负载上升，3 分钟静置未回落；下一步需要用 WebView/进程分配证据定位增长来源，不能仅凭 RSS 判定具体泄漏，也不能用 Tauri 宿主约 149 MiB 宣称整体内存更低。更强并发下已观察到的 2000 行待写队列溢出仍保留。取消逐行动画减少本轮可见场景的压力，不构成任意负载下历史完整或无限运行无泄漏的保证。


## 标题启动校验与保留窗口

长跑证据封存后，原生测试宿主按新的正式标题配置重新构建，进行双端 10 秒、50 条/秒的启动验收 `/tmp/mqtt-desktop-soak-wFnSKh`：每端 500 条完整接收/保存，`passed=true`，Broker 套接字 0、服务关闭、清理后历史为空。Tauri 原生 `window.title()` 和 Electron 页面目标标题均为 `iNeed MQTT Tool`；标题检查证据在该目录的 `title-check.json`。Electron 窗口检查 12/12、Tauri 配置边界 9/9，lint、Rust fmt 和原生构建通过。

旧长跑实例在证据归档后关闭，当前保留的是本次标题校验的两个隔离窗口，仍按并排约 1120×800 显示。用户可以继续观察桌面窗口，但它们重新启动后的资源数值不能替代前面 20 分钟长跑的资源记录。

## 2026-10-13 压力遗留修复与最终可见验收

修复起点为 `7dfc7c9`，保留先前应用内更新的全部未提交改动。本轮修改和验证尚未提交，没有构建安装包、上传或发布。

接收历史改为原生先落盘：Electron `receivedHistory.cjs`、Tauri `Database::save_received_messages` 按匹配订阅选择 text/json/hex 格式，批次事务成功后再向界面投递 `historyPersisted: true`。共享工作台不重复保存这些记录，预览等旧适配器仍走原来的界面队列。Electron 投递重试复用提交标记，断开前保存最后不足 200 条的批次；原生写入失败进入错误状态并阻止严格更新准备成功。原数据库结构、应用 ID 和用户目录保持兼容。可选收包日志仍有独立的有界队列，本轮完整性结论针对接收消息历史。

可见消息区按视口和预取范围渲染，顶部/底部 spacer 保留所有实时保留消息的滚动访问；筛选仍处理全部保留记录，复制、详情、暂停和恢复跟随保持原行为。ResizeObserver 测量合并到下一动画帧，避免真实复现过的循环错误。暂停阅读后裁剪旧消息会恢复阅读锚点；新增浏览器回归复现 Chromium 再次自动锚定带来的约 21px 偏移，消息容器关闭浏览器锚定后消除该偏移。原有实时保留量没有缩小。

短对照曾试验 content-visibility、气泡 overflow、禁用 DevTools 和 Tauri Channel，均不足以证明停止增长，最终未采用。进程分配证据显示大量 Malloc/graphics 分配以及消息区滚动/绘制开销，支持减少 DOM 周转；没有据此认定 WebKit 的具体底层泄漏根因。

增强短测 `/tmp/mqtt-desktop-soak-rRaCNq`：两端可见，3 分钟目标 1,000 条/秒，每 5 秒真实阻塞渲染线程 3 秒，再静置 30 秒。每端接收并保存 168,800 条，缺失/重复/非法 payload/页面错误为 0；各分钟 DOM 3 行，最新序号和跟随正常，测试历史清空、Broker sockets 0、driver 退出码 0。约 3 秒的心跳延迟来自主动注入，不能当作自然交互延迟。该短测没有独立扫描全量 SQLite 序号集合。

正式长跑前，锁屏导致的 `syw1VD` 启动失败、旧资源宿主 `woAO5r`、截图超时 `etw7Yd` 及 Tauri 最小化的 `wDtRRI` 都未计作通过。用户解锁后重新核对系统会话；测试宿主启动和 SHOW 显式恢复窗口，driver 同时记录 Electron/Tauri 原生窗口状态。截图使用独立 3 秒超时并记录采集错误，数据、原生窗口和 WebView 可见性门禁仍严格执行。最终运行没有截图采集错误。

最终目录 `/tmp/mqtt-desktop-soak-tDhK8q`，UTC `2026-10-13T09:07:51.641Z` 开始。两端窗口均可见、未最小化；20 分钟负载实际 1,202,853ms，加 3 分钟静置，总计 1,389,595ms。每端 571,300 条接收和历史完全一致，目标 500 条/秒，含每分钟操作与暂停后的实际均值 474.95 条/秒。20 个负载样本和 17 个静置样本均可见、跟随最新，页面启动标识及关联 WebKit PID 不变，DOM 3 行，缺失/重复/非法 payload/页面错误为 0。100ms 心跳没有记录超过 200ms 的额外延迟；这不是完整交互延迟分布。每分钟 `catchupWaitMs` 为 913–1,513ms，包含界面操作和查询，不是纯落盘耗时。

清理前直接只读查询两端 SQLite：每端 571,300 行、571,300 个不同整数序号、最小 1、最大 571,300、非法序号 0，`quick_check=ok`，排除只核对总数会掩盖的重复/缺失组合。最终 `passed=true`，清理后历史为空，Broker sockets 0、服务关闭，driver 退出码 0。本轮测试窗口正常关闭，原先用户窗口保留。精简证据见 [修复后可见长跑 JSON](mqtt-desktop-soak-fixed-visible-2026-10-13.json)；完整样本、日志及第 1/10/20 分钟截图在工具工作区 `scratch/2026-10-13-mqtt-soak-fixes/visible-final/`。

| 进程组 | 首次负载 RSS | 峰值 RSS | 负载结束 RSS | 静置结束 RSS |
| --- | ---: | ---: | ---: | ---: |
| Electron 全进程树 | 640.6 MiB | 723.0 MiB | 723.0 MiB | 664.3 MiB |
| Tauri 宿主 | 146.1 MiB | 147.6 MiB | 147.6 MiB | 147.6 MiB |
| 关联 WebKit 进程 | 325.9 MiB | 433.6 MiB | 433.6 MiB | 433.2 MiB |

关联 WebKit 峰值比前轮 1,425.1 MiB 下降约 70%，第 12–20 分钟在 427.1–433.6 MiB 范围内，未再复现前轮快速持续增长；静置未明显释放。该结果支持本轮布局和原生落盘修复在明确负载下有效，有限的时长和 RSS 样本仍不能排除所有泄漏或承诺任意负载完整。RSS 分组及共享页限制沿用前文口径。

回归：Node 串行 590/590、组件 103/103、Rust lib 76/76、双入口 Chromium/WebKit 工作台矩阵 84/84；lint、双 renderer / 原生测试宿主构建、Rust fmt 和 diff 检查通过。新增全量序号、读取锚点、跟随与虚拟 DOM 校验均纳入长期测试入口。

复现时先构建当前资源和嵌入它的测试宿主，然后选择负载：

```sh
npm run build:renderers
TAURI_CONFIG='{"build":{"devUrl":null}}' cargo build --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --features desktop-soak --bin desktop_soak_harness
SOAK_SECONDS=180 SOAK_RATE=1000 SOAK_IDLE_SECONDS=30 SOAK_EXPECT_VISIBLE=1 SOAK_RENDERER_BLOCK_MS=3000 node tooling/desktop-soak/run.mjs
SOAK_SECONDS=1200 SOAK_RATE=500 SOAK_IDLE_SECONDS=180 SOAK_EXPECT_VISIBLE=1 node tooling/desktop-soak/run.mjs
```

本轮覆盖 macOS arm64 原生测试宿主的生产界面、MQTT 和 SQLite，不代表生产安装包启动/替换、更新安装、Windows/Linux/macOS x64 或无限时长验收。

## 2026-10-13 静置内存补查

用户指出静置 RSS 未回落仍需调查。本轮使用当前修复版本的生产资源和原生宿主，保持两端窗口可见，在同一组进程中完成三轮各 2 分钟、目标 500 条/秒的接收；每轮静置 1 分钟，再清空实时视图、等待 30 秒、断开、等待 30 秒并重连。没有强制 GC、重载页面或重启进程，也没有修改产品行为。

目录 `/tmp/mqtt-desktop-soak-sUi5co`，从负载开始至收尾 773,379ms。每端累计 178,200 条接收和历史一致，缺失/重复/无效载荷/页面错误为 0；独立 SQLite 序号为 1–178,200，distinct=178,200、非法=0、quick_check=ok。passed=true、driver 退出码 0，清理后历史为空、Broker sockets=0、服务关闭。全部诊断阶段页面启动标识不变且 visibility=visible；Tauri 原生窗口可见、未最小化，WebKit 关联 PID 不变。清空后两端 DOM 消息行均为 0，总 DOM 元素数回到 206。

各阶段额外采集 `vmmap -summary` 和 `heap -s`。下面 footprint 沿用 heap 输出的 M 原值；它与 ps RSS 在不同瞬间采集，不能把二者相减当作精确缓存大小。堆分配字节为原生 allocator 口径，不是 JavaScript 可达对象大小。

| 阶段 | 关联 WebKit RSS（MiB） | WebContent footprint（heap 原值） | WebContent 堆分配（MiB） | Tauri 宿主 RSS（MiB） |
| --- | ---: | ---: | ---: | ---: |
| 初始 | 133.3 | 207.6M | 27.07 | 144.0 |
| 第 1 轮负载后 | 304.9 | 267.3M | 112.81 | 147.3 |
| 第 1 轮静置后 | 301.7 | 135.1M | 104.61 | 147.2 |
| 第 1 轮断开静置后 | 301.4 | 125.9M | 104.31 | 147.2 |
| 第 2 轮断开静置后 | 350.7 | 147.4M | 128.71 | 147.6 |
| 第 3 轮断开静置后 | 369.3 | 136.0M | 108.24 | 172.0 |

第 1 轮静置时 footprint 明显下降，而 RSS 变化很小；三轮断开后的 footprint 和原生堆分配未呈持续递增。这补充了回收确实发生的证据，不能将「RSS 不降」直接等同于「完全没有回收」。Tauri 宿主第三轮 RSS 增加约 24 MiB，同样未定位具体分配来源；两端多次重连与有限时长不构成无限运行的保证。

原生 `leaks --noContent --groupByType` 扫描第三轮静置 WebContent，报告 1 个 32 字节的 NSMutableDictionary root leak，退出码 1；未采集分配调用栈，不能归因到产品代码，它也不足以解释剩余的几十到上百 MiB 分配。该工具不能排除 JavaScript 仍可达的对象。生产优化构建没有暴露 setupState 消息数组，诊断中的 retainedMessages/retainedLogs 为 null，不作为引用释放证据；原生文本节点数量也不等同于界面的 DOM 行数。

**该次诊断完成；用户随后要求继续定位，进展见下节。** 原快速持续增长已有布局修复与 20 分钟验收支持；本次未确认剩余占用的具体缓存或泄漏根因，没有据此增加内存释放代码或宣布所有内存问题解决。

精简结果见 [内存补查 JSON](mqtt-memory-recovery-2026-10-13.json)。完整原生分配、样本、日志和可复现诊断脚本归档在工具工作区 `scratch/2026-10-13-mqtt-memory-recovery/`；本轮原生压力结果不代表生产安装包、其它操作系统或真实升级验收。

## 2026-10-13 活跃堆定位与测试宿主品牌

`desktop_soak_harness` 是开启 `desktop-soak` feature 后构建的隔离测试入口，加载实际生产界面、MQTT 服务和 SQLite。裸可执行文件启动时，macOS 的 Dock 使用文件名作为应用名称。现在 `tooling/desktop-soak/tauriExecutable.mjs` 按正式主窗口标题创建临时 `.app` 外壳，复制当前 ICNS、设置 CFBundleName/CFBundleDisplayName 并本地 ad-hoc 签名；正式压力入口同时使用已有品牌 Electron 开发宿主。测试数据继续隔离，临时应用 ID 不替换正式产品身份，签名不构成正式发行签名。

原生红/绿验证：旧 Tauri `NSRunningApplication.localizedName=desktop_soak_harness`，新宿主的 Dock 名称和 AX 应用菜单均为 `iNeed MQTT Tool`。最终双端短测 `/tmp/mqtt-desktop-soak-ZkF0xK`，10 秒目标 50 条/秒，每端 500 条完整接收/保存、SQLite 全量序号和 quick_check 通过；两端原生名称/菜单均通过独立 Swift 断言。未再保留裸测试宿主窗口。

活跃 JS 堆诊断 `/tmp/mqtt-desktop-soak-XGgGyE`，2 分钟目标 500 条/秒，每端 58,600 条完整。仅测试 binary 增加显式 PROBE 入口，在 macOS 主线程加载本地 Inspector 桥接；生产 app 没有此入口。WebKit `Heap.snapshot` 会隐式进行 Full GC，所以这些数据用于判断存活引用，不能替代正常可见长跑。

| 阶段 | 活跃 JS 堆估算 | 实时消息对象 |
| --- | ---: | ---: |
| 初始 | 3.28 MiB | 0 |
| 负载结束 | 3.88 MiB | 300 |
| 清空后 | 4.61 MiB | 0 |
| 断开静置后 | 3.53 MiB | 0 |

根据包含 `displayPayload`、`connId`、`direction` 的 Property 边识别实时消息对象。结果支持保留上限和清空释放有效，清空后的代码块增量也在静置后回落；不能将 JS 堆估算当作整个 WebContent 的内存。最后原生堆仍约 89.03 MiB，具体来源尚未全部归因。

为检查 Inspector 干扰，另跑 `/tmp/mqtt-desktop-soak-uxplea`：不开 Inspector、不采 JS 快照、不强制 GC，2 分钟负载、45 秒静置及清空/断开后各 30 秒观察，总 246,842ms。每端 58,400 条完整，全量 SQLite 序号/quick_check、页面启动标识和可见性门禁通过，清理后历史为空、Broker sockets=0。WebContent 原生堆由初始 27.13 MiB 到负载后 141.35 MiB，断开静置后 108.23 MiB；heap footprint 从负载后 301.5M 降到 156.2M，RSS 仍约 239.3 MiB。

原生 304/528/1,024/3,584/16,384 字节分配的抽样逆引用树已保存，部分路径通向 common VM、JSVMClientData、线程全局数据；这些扫描可能包含保守引用，不能把样本归因推广到全部剩余分配。`xctrace Allocations` 对 WebContent 最终因 SIP restricted process 拒绝附加，退出码 2，没有成功取得分配调用栈，也没有修改系统保护。

**状态：品牌显示修复并验证；内存根因仍在定位。** 已证明旧实时消息释放及物理占用回收，尚未确认剩余原生分配的具体缓存或泄漏来源，产品未加入强制 GC 或重载行为。当前证据见 [定位进展 JSON](mqtt-memory-root-cause-2026-10-13.json)，原始快照、引用树、日志和脚本在工作区 `scratch/2026-10-13-mqtt-memory-root-cause/`。该结果不代表正式安装包或其它平台验收。
