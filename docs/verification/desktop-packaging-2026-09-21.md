# Ineed MQTT Tool 多平台打包首轮验证

日期：2026-09-21。实施范围为安装配置、跨平台构建入口、产物完整性校验与本机 macOS 安装包构建。产品仍为 0.1.0，未提交代码、推送远程或发布公网站点。

## 已执行

- 定向打包测试：28 项通过，0 失败。包含真实配置读取、Windows 向导 / 用户数据保留约定、CLI 参数边界、Linux 多格式集合、摘要篡改 / 缺件 / 重复 / 路径逃逸与伪造文件头拒绝。
- `npm run lint`：0 错误、0 警告；`git diff --check` 通过。
- 使用安装在项目中的 Tauri / electron-builder schema 核对新增配置字段；通用 JSON 校验器仅对 Tauri 自定义数字 format 注解不作判断，实际 macOS Tauri 构建也已成功解析同一配置。
- Windows 与 Linux `release:plan` 成功生成命令；这些命令未在本机伪装为目标系统执行。
- 新流程实际构建 Electron arm64 / x64 与 Tauri arm64 / x64，共 4 个 DMG；新集合完整性验证通过。
- 所有 DMG 均只读挂载，检查 Info.plist 的产品名 / identifier / 版本与 lipo 的原生架构；Electron 包内 app.asar 或编译后 index.html 存在。

| 运行时 | 架构 | 本次产物 | 包元数据检查 |
| --- | --- | --- | --- |
| electron | arm64 | [ineed-mqtt-tool-0.1.0-electron-macos-arm64.dmg](../../release/desktop/0.1.0-20260921T012913798Z-0c0117e2/ineed-mqtt-tool-0.1.0-electron-macos-arm64.dmg) | passed |
| electron | x64 | [ineed-mqtt-tool-0.1.0-electron-macos-x64.dmg](../../release/desktop/0.1.0-20260921T012913798Z-0c0117e2/ineed-mqtt-tool-0.1.0-electron-macos-x64.dmg) | passed |
| tauri | arm64 | [ineed-mqtt-tool-0.1.0-tauri-macos-arm64.dmg](../../release/desktop/0.1.0-20260921T013014924Z-db43e7de/ineed-mqtt-tool-0.1.0-tauri-macos-arm64.dmg) | passed |
| tauri | x64 | [ineed-mqtt-tool-0.1.0-tauri-macos-x64.dmg](../../release/desktop/0.1.0-20260921T023155614Z-446d9134/ineed-mqtt-tool-0.1.0-tauri-macos-x64.dmg) | passed |

具体路径、SHA-256 与包元数据见 [JSON 证据](desktop-packaging-2026-09-21.json)。正式发布的最终字节仍须在签名 / 公证之后重新生成摘要。

## 构建过程中的处理

Electron 首次下载卡在 GitHub 连接，停止了本次任务自己的构建子进程，失败暂存日志保留。补充已有项目的二进制镜像默认值，并使用本机同版本、同架构的 Electron 缓存重新构建成功。没有清理用户以前的安装包集合。

新版 Windows Electron 目标为 NSIS，不再采用 portable 作为主入口。Tauri 使用离线 WebView2 安装器、当前用户 NSIS 和中英文向导。LinkLab 图标通过跨平台 Tauri icon CLI 生成，包含此前缺少的 Windows ICO。

## 尚未完成的目标系统验收

本次未执行 Windows / Ubuntu / Debian 的原生安装，也未运行这些系统上的网络通信、SQLite 升级和串口硬件验收。当前 Mac 发现 Docker CLI，但 daemon 不可连接；没有可用的 Windows 构建 / 验收环境。

macOS 本轮完成构建、产物完整性与包元数据检查，没有重新运行安装后 GUI、网络、串口或全部业务端对端测试。Info.plist 的最低版本字段不等于对该旧系统做过运行认证；Intel 包的交叉构建也不等于 Intel 实机验收。

产物没有正式代码签名 / 公证验收，暂不接网站的正式下载链接。`release:verify` 明确输出 installation / runtime / signing 未验证，不能用文件摘要检查替代这些关卡。独立暂存目录中的日志不作为成功产物发布。

## 下一步操作

按 [桌面构建说明](../desktop-packaging.md) 在 Windows 执行 `npm run package:win`，在 Linux 执行 `npm run package:linux`。先完成当前用户安装、离线 WebView2、升级保留数据和原生通信验收，再配置签名及网站下载。
