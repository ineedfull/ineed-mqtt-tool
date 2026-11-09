# MQTT 应用内更新设计

日期：2026-10-13。状态：用户确认先实现和隔离测试；两端实现已完成，正式安装升级与公网发布待签名材料。

## 目标与当前事实

Electron 与 Tauri 共用「检查更新 → 下载新版 → 校验 → 重启并安装」界面。只有用户点击重启安装后才停止 MQTT 与退出；下载和校验失败保留当前安装。

实施前两端只读取 `https://mqtt.ineedfull.com/updates/latest.json`，按自身渠道比较版本，并通过浏览器打开下载地址。2026-10-13 实测该 HTTPS 地址返回 200、application/json，但 `releases` 为空。Electron 更新检查专项 12/12 通过，未证明下载安装可用。

当前标准构建收集 DMG、NSIS EXE、DEB/AppImage；清单只包含安装包和 SHA-256。实施前尚未收集原生更新器所需的全部制品、签名与 feed；本轮已新增独立更新集合入口。不能直接把现有 DMG 当成通用更新制品。

## 路线选择

| 路线 | 收益 | 成本与限制 | 决定 |
| --- | --- | --- | --- |
| Electron 使用 electron-updater，Tauri 使用官方 updater 插件 | 复用平台安装、制品校验和签名机制，支持进度 | 需要按更新器生成制品和元数据，并提供签名材料 | 推荐 |
| 自己下载并编写 DMG 挂载、文件替换和安装脚本 | 可沿用部分安装包 | 需要维护权限、运行中替换、文件占用及失败恢复；两端和各系统分支更多 | 不采用 |
| 应用内下载后打开系统安装器 | 比浏览器下载方便 | 仍需手动完成安装，不能完整实现本次目标 | 作为不支持自动安装渠道的明确后备行为 |

遵循现有 electron-builder 26.15.3 和 Tauri 2 工具链，选择实际兼容的更新器版本并锁定依赖。上游 master 文档包含新版 API；实现前核对选定版本源码，不直接套用新版选项或升级整套打包工具链。

## 用户操作与状态

关于页复用现有主题与字号变量，不另建两套工作台。状态为 idle、checking、available、downloading、verifying、ready、preparing、installing、error。

1. 点击「检查更新」，显示当前与目标版本、发行说明及可用安装方式。
2. 点击「下载更新」，显示已下载字节、总大小与进度；无法获知总大小时使用不定进度，不能显示虚假的百分比。
3. 下载后的摘要及更新器签名验证全部通过，才显示「重启并安装」。校验失败清理无效缓存，允许重试。
4. 下载期间可继续使用工作台。取消能力按选定更新器实际 API 提供；不能展示无效的取消按钮。关闭关于页不会重复下载或丢失进度，重开时读取原生状态。
5. 用户点击「重启并安装」时先提示 MQTT 连接将断开，并展示「正在保存数据」。保存成功才调用原生安装器。关闭应用时不擅自安装；关闭后保留的缓存须在下次使用前重新验证。

重复检查、重复下载和重复安装由原生状态控制；不能仅依靠按钮 disabled。历史窗口无权调用更新安装 IPC。渲染层不传入可执行路径、安装参数、摘要、公钥或任意 feed URL。

## 共享层与运行时边界

共享 Vue 工作台处理展示与用户操作；`packages/runtime-contract`、runtime facade 和两个 adapter 定义相同的 check、getState、onState、download、cancel（能力允许时）、install 方法。原生端保留经过检查的版本和制品身份；下载与安装均只能使用该身份。

Electron 新建独立更新控制器，main/preload 只负责授权 IPC 和连接退出流程。控制器包装 electron-updater，显式关闭自动下载与退出自动安装，禁止降级。状态订阅带当前快照，页面重新挂载也能恢复。

Tauri 在 Rust 中包装官方 updater 插件，通过限定 command 与事件向共享界面提供相同能力。插件完成更新签名校验；公钥由可信构建配置嵌入，不能由站点清单覆盖。更新下载与安装分开，下载完成不直接调用 download_and_install。

开发模式与未配置签名的构建明确显示能力限制，不能为了测试关闭生产校验。测试替身限定在测试宿主；正式应用不接受环境变量提供任意 HTTP 更新源或跳过签名。

## 制品与静态服务

| 渠道 | 人工安装包 | 应用内更新制品 | 验收边界 |
| --- | --- | --- | --- |
| Electron macOS arm64/x64 | DMG | 签名应用 ZIP 与 electron-updater 元数据 | 必须具备 macOS 代码签名，真实安装后升级验收 |
| Tauri macOS arm64/x64 | DMG | 官方生成的 `.app.tar.gz` 与 `.sig` | 必须验证更新签名，并验收应用替换、启动与 macOS 发布签名 |
| Electron Windows x64 | NSIS EXE | NSIS 制品、摘要与更新元数据 | 发布证书身份固定，在 Windows 原生验收 |
| Tauri Windows x64 | NSIS EXE | 官方 updater 制品与 `.sig` | 按所选插件/CLI 版本生成；安装前保存数据，Windows 安装阶段会退出应用 |
| Electron/Tauri Linux x64 AppImage | AppImage | 对应原生更新器制品与完整性/签名元数据 | 在受支持发行版验证路径权限与重新启动 |
| Linux DEB | DEB | 本轮保留旧浏览器下载与手动系统安装流程 | 需要系统包管理器与授权；不宣称两端均能无交互重启安装 |

人工安装包格式继续遵循跨工具打包规范。自动更新增加专用发布入口、附加制品集合及验证，不把三仓库公共脚本改成只有 MQTT 能使用的版本。LinkLab/NetTool 不在本轮接入更新器。

更新清单由构建脚本从最终制品生成，不人工填写摘要。Electron feed 按 OS/CPU 隔离，使用官方 `latest*.yml`；Tauri 使用官方 JSON 与 `.sig` 内容。保留现有 schemaVersion=1 清单供旧检查客户端使用，新客户端使用明确的原生更新 feed。两种清单的版本与渠道必须来自同一最终发布集合。

安装包与附加更新制品放在 146 私有桶 `ineed-downloads` 的 `ineed-mqtt-tool/<version>/<buildId>/` 下，逐件回读验证。站点 Nginx 承载小型版本元数据；文件通过 146 的有效 HTTPS 下载入口提供，无需 CDN。URL 指向不可变对象；元数据响应使用 no-cache。不得将 MinIO 管理凭据放入客户端。

发布顺序为最终签名 → 收集/验证制品与元数据 → 私有上传/回读 → 验证公开 HTTPS 下载 → 原子发布 feed。元数据不得先指向不存在、未签名或未验收的制品。上传成功不自动等于公开发布。

## 校验与退出前保存

HTTPS 保护传输，摘要检测字节损坏，签名验证发布身份；三者用途不同。Electron 使用所选版本内置的 SHA-512 和平台签名机制；Tauri 使用强制更新签名。发布集合仍记录 SHA-256、大小、版本、runtime、OS/CPU。缓存重新使用时校验同一版本和身份，过期或损坏缓存不可安装。

现有工作台 teardown 使用 Promise.allSettled 并记录超时，普通关闭流程可继续退出；更新安装不能复用这种「失败后仍继续」的结果。新增严格的更新准备路径：阻止新发布/编辑操作、停止定时任务、等待正在进行的保存与发布完成、断开 MQTT、排空原生和渲染层消息/日志、保存设置、执行 SQLite FULL checkpoint；正常退出时再关闭数据库，失败时保留可用数据库。每一步失败或超时均中止安装并显示错误，不能在仍有待写记录时替换应用。

安装准备必须避免把调用 install 本身计入等待中的业务操作造成自等待。只有主窗口能完成带 requestId 的保存确认；过期、重复或其他窗口的确认无效。失败后恢复可继续使用或清晰引导重开，不销毁窗口后再报告失败。SQLite 结构、应用 ID 和既有数据目录保持兼容，不以删除用户目录解决升级失败。

原生安装器负责其支持的替换行为；不能把这解释成所有系统任意中断都可无损自动回退。保留前一版人工安装包，但已有新数据库结构时禁止自动降级。

## 测试与验收

先为原生更新控制器、共享状态和发布集合写失败测试，再实现。

- 检查：无更新、有更新、同版/旧版、错误渠道、错误清单、超时、响应过大、无效 HTTPS 地址。
- 下载：真实本地服务的分块/断流/中途失败、并发点击、取消能力、空间不足、损坏制品、摘要/签名不符、缓存重用。
- 安装：未就绪拒绝安装、下载失败不安装、保存失败不安装、断开和落盘完成才调用安装器、重复请求不重复执行、子窗口/外来 IPC 拒绝。
- UI：浅色/深色、普通/大字、侧栏展开/折叠、窄窗口、关闭并重开关于页、异常后可重试。浏览器模拟只证明展示；原生接口另验收。
- 真升级：每个可执行宿主环境以隔离 profile 从较旧测试版本升级到较新版本，核对重启后的版本、连接、设置、历史数量与 SQLite quick_check。不能用打开系统安装器代替实际更新完成。

本机 macOS arm64 优先做双端真实安装升级；macOS x64、Windows/Linux 原生验收分别记录所需环境。缺少正式证书时测试签名仅用于隔离证据，不能写入公开 feed。生产构建缺少签名或信任配置明确失败。

## 配置前提与交付边界

待补充的外部信息是 Apple Developer ID、Windows 代码签名证书、Tauri 长期更新密钥的配置位置及 146 公开 HTTPS 下载入口。不会请求用户在聊天中粘贴私钥或密码。没有签名材料仍可开发控制器、界面、发布校验和隔离测试，但不能宣布正式安装升级链路通过。

用户已确认先实施和隔离测试，代码、锁定依赖与发布集合入口已完成。实现细节和验证边界见 `docs/in-app-updates.md` 与工作区任务。未生成正式安装包、执行真实升级、上传或发布远端。

## 参考

- Tauri 官方 updater：[文档源](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/updater.mdx)。明确要求更新签名、支持静态 JSON、分开的 download/install，Windows 安装阶段退出。
- electron-builder / electron-updater：[官方文档源](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/auto-update.md)。明确 macOS 签名与 ZIP、平台制品、进度和更新元数据；master 的新版选项需核对锁定版本后采用。
- 项目现状：`docs/desktop-packaging.md`、`apps/electron/electron/main.cjs`、`apps/tauri/src-tauri/src/update.rs`、`apps/tauri/src-tauri/src/lifecycle.rs`、`packages/workbench/src/layouts/MqttToolShell.vue`。
