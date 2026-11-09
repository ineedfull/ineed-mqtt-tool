# MQTT 应用内更新

Electron 与 Tauri 共用关于页的检查、下载、校验、取消、确认重启和错误展示。下载安装由各自原生端控制。代码与隔离测试已完成；正式证书、真实安装替换和公网升级尚未验收。

## 用户行为

下载期间可以继续使用 MQTT；关闭关于页后下载继续，重新打开显示当前状态。只有已校验的制品提供「重启并安装」，再次确认后停止定时发布、等待业务操作、断开 MQTT，保存消息、日志和设置，再执行 SQLite FULL checkpoint。保存失败或超时中止安装；超时后的旧准备任务不会继续进入下一阶段。

普通关窗仍使用已有退出流程。更新准备使用严格保存握手，不接受普通退出流程中的尽力保存结果。队列曾溢出或历史写入最终失败时，本次会话拒绝安装，以免把丢失记录误当成已保存。SQLite 不提前关闭，避免安装失败后无法继续使用；正常退出时关闭。

未配置更新公钥的开发运行和现有人工安装包继续读取旧检查 JSON，通过浏览器下载。应用内更新能力来自专门的更新构建：Electron 将公钥写入打包资源，Tauri 在编译时嵌入。已有旧客户端需要先人工安装一次包含信任配置的版本，才能参与下一次应用内升级。当前版本仍为 0.1.0，尚未生成新的正式版本。

## 原生信任与渠道

| 运行时/系统 | 更新制品 | 校验 |
| --- | --- | --- |
| Electron macOS arm64/x64 | ZIP 内的签名应用 | Ed25519 元数据签名、SHA-512、平台签名 |
| Electron Windows x64 | NSIS EXE | 同上；固定发行者 |
| Electron Linux x64 | AppImage | Ed25519 元数据签名、SHA-512 |
| Tauri macOS arm64/x64 | app.tar.gz + sig | Minisign；trusted comment 绑定版本 |
| Tauri Windows x64 | NSIS EXE + sig | 同上；正式代码签名 |
| Tauri Linux x64 | AppImage + sig | 同上 |

Linux 的自动安装只对正在运行的 AppImage 开启。DEB 保留旧手动下载安装方式，不承诺无交互替换。

原生 feed 固定在 MQTT 站点：

- Electron：`https://mqtt.ineedfull.com/updates/electron/<macos|windows|linux>/<arm64|x64>/latest*.yml`。macOS 使用 latest-mac.yml，Windows 使用 latest.yml，Linux x64 使用 latest-linux.yml。
- Tauri：`https://mqtt.ineedfull.com/updates/tauri/tauri-<OS>-<Rust CPU>.json`，如 tauri-macos-aarch64.json。
- 旧检查：`https://mqtt.ineedfull.com/updates/latest.json`，保留 schemaVersion=1。

下载链接限定 HTTPS、`downloads.ineedfull.com/ineed-mqtt-tool/`。Electron 元数据签名覆盖渠道、版本、URL、大小和 SHA-512；安装前重新校验缓存。Tauri 官方插件开启 requireSignedVersion，下载签名通过才缓存字节，安装前再次验签和核对版本。原生安装命令只允许主窗口；更新签名私钥和 MinIO 管理凭据不进入客户端。

Electron 单件制品上限 1 GiB；Tauri 下载上限 512 MiB，检查超时 10 秒、请求超时 300 秒。Tauri 更新缓存保存在原生内存，退出后重新下载。原生 feed 使用官方解析器，本轮没有证明任意超大元数据响应都被固定字节上限阻断。

## 发布入口与配置

原 `release:plan/build/verify/upload` 仍用于跨 Tool 人工安装包。新增独立入口：

```sh
npm run release:updates:plan -- --platform=macos --arch=arm64
npm run release:updates:build -- --platform=macos --arch=arm64
npm run release:updates:verify -- --dir=/absolute/release/updates/collection
npm run release:updates:upload -- --dir=/absolute/release/updates/collection
```

plan 不需要私钥、不会构建。build 在目标系统运行，缺少签名配置在创建输出前停止；输出为 `release/updates/<buildId>/`，与人工打包共用构建锁。所有版本字段遵循既有跨运行时版本检查，发布前需要按产品发布流程更新版本。

| 作用 | 环境变量 |
| --- | --- |
| Electron 更新密钥 | INEED_ELECTRON_UPDATE_PUBLIC_KEY_FILE / INEED_ELECTRON_UPDATE_PRIVATE_KEY_FILE |
| Tauri 更新密钥 | INEED_TAURI_UPDATE_PUBLIC_KEY_FILE / TAURI_SIGNING_PRIVATE_KEY_PATH / TAURI_SIGNING_PRIVATE_KEY_PASSWORD |
| macOS 身份 | APPLE_SIGNING_IDENTITY / APPLE_TEAM_ID |
| Windows 发行者 | INEED_WINDOWS_PUBLISHER |
| Electron Windows 证书 | CSC_LINK，以及证书所需的 CSC_KEY_PASSWORD |
| Tauri Windows 证书 | INEED_WINDOWS_CERTIFICATE_THUMBPRINT；证书需在目标 Windows 证书存储中可用 |

Electron 公钥使用 Ed25519 PEM；Tauri 使用官方 signer 的 Base64 公钥/私钥文件。私钥和密码从受控环境读取，不存入源码、任务记录或聊天。Apple 身份必须为 Developer ID Application；构建完成还执行 codesign 深度校验、身份/Team 核对和 spctl，因此还必须正确配置工具链的公证凭据。Windows 制品完成后核对 Authenticode 状态和发行者，配置了指纹时也核对指纹。配置字符串测试不代替真实证书验收。

构建收集原生更新制品、macOS 兼容 DMG、签名、两类 feed 与 manifest.json。所有大小、SHA-256/SHA-512 从最终文件生成；verify 使用独立传入公钥，拒绝篡改、重复渠道、缺件和额外文件。兼容 JSON 的 DMG 地址来自实际 DMG，不把 ZIP 冒充为 DMG；Linux 当前集合只产生 AppImage 条目，DEB 条目须由已验证的人工安装集合补齐。

upload 使用共享 `ineed-downloads` 私有桶、产品/版本/buildId 前缀，逐件回读大小和 SHA-256，同键内容不同就拒绝覆盖；回执写入 `release/uploads/ineed-downloads/`。本轮仅测试替代存储传输，没有连接 146 或上传真实制品。

上传不发布站点 feed。正式顺序是：签名与公证完成 → 集合验证 → 私有上传/回读 → 校验 146 公网 HTTPS 下载 → 隔离安装升级验收 → 原子发布元数据。manifest.feeds 的 target 是 Nginx updates/ 下的相对目标路径；native feed 优先发布，兼容 latest.json 最后发布、使用 no-cache。单个平台集合的兼容清单仅包含该集合，跨平台发布需要合并各个已验证集合的条目，不能直接用单平台 JSON 覆盖全部平台。文件直连 146，无 CDN。

## 研发阅读与测试

- Electron 控制器：`apps/electron/electron/updateController.cjs`；握手：`updatePreparation.cjs`，注册和保存顺序在 main.cjs。
- Tauri 控制器：`apps/tauri/src-tauri/src/native_update.rs`；签名验证：update_signature.rs，release-signing feature 下的 bin/update_signature.rs 为发布辅助程序。
- 共享界面：`packages/workbench/src/components/UpdateProgress.vue` 与 MqttToolShell.vue；严格保存：workspace/prepareUpdate.js、batchedPersistence.js、settingsPersistence.js。
- 发布集合：`scripts/update-release.mjs`。

```sh
npm run test:updates
npm run test:updates:signing
npm run test:updates:ui
npm run test:components
cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --lib
```

隔离证据包括：真实 electron-updater 回环分块下载和 SHA-512；真实 Tauri 插件配合 MockRuntime、回环 HTTP 与临时 Minisign 密钥的下载验签；真实签名 CLI 与发布集合生成；损坏字节/错误版本/错误公钥拒绝；主窗口保存回执和 SQLite 锁拒绝；共享工作台最后消息保存、失败恢复与超时旧任务中止；两端 Chromium/WebKit 的浅/深、普通/大字、窄窗口和折叠菜单 UI。

浏览器与替代安装器仅证明交互、状态和门禁，尚未执行真实替换安装。正式 macOS/Windows/Linux 需要从较旧的可信安装包升级到较新版本，核对重启版本、连接/设置/历史、SQLite quick_check，以及安装中断和文件权限。已有 20 分钟压力测试中的 WebKit 内存不回落与更强负载历史队列溢出仍保留，本任务不代表这些问题已解决。
