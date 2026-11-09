# MQTT Tool：2026-10-30 发布前收尾验证

## 源码与门禁

源码归档 16dc6bd；安装入口模块保留 85a69a5；macOS 内部 Bundle/Helper 名称对齐 3b7548d。最后一项仅影响 macOS Electron，Windows/Linux/Tauri 安装文件仍准确标记为 85a69a5。

shared 326、Electron 143、组件 108、Tauri JS 契约 49、Rust 77；lint、renderer build；打包回归 38。

## 持续负载

Electron/Tauri 可见窗口 20 分钟持续负载及 180 秒静置，每端 572,300 条，序号、数据库行数和 quick_check 一致。测试清理 Broker 和隔离历史。

有限时长的内存采样出现恢复，不代表排除所有长期泄漏；同时运行构建，不能用本轮 RSS 精确比较不同产品。全部测试使用隔离用户数据和回环服务，未使用用户云账号施压。

## 实际候选包

macOS Electron arm64 原始 DMG 两轮窗口启动、真实本地 Broker 收发、配置/历史重启保留及同版本替换通过；全部 DMG 身份/版本/架构通过。Tauri arm64 原始包 smoke 通过，x64 结构检查。

Linux x64 DEB/AppImage 载荷和摘要一致，提取后的实际应用在 Ubuntu + Xvfb 两轮 GUI、真实回环通信及重启替换通过。未宣称物理桌面、系统级 DEB 安装或 FUSE 验收。Windows x64 NSIS 在 Wine 9 实际安装/覆盖安装/卸载、载荷一致及生成的 SQLite 哨兵保留通过，嵌入 Node/SQLite 可加载。新 NSIS 模板遇到 Wine 返回成功的 PowerShell 空实现，仅在私有测试环境禁用该空实现后使用安装器官方 tasklist 备用路径；未修改生产安装器。

Windows 实机 GUI、真实旧用户数据升级、DPAPI、Intel Mac 与实体设备仍待对应环境。

本轮安装文件为未正式签名的测试包；没有发布签名自动更新 feed。同版本替换不能替代正式跨版本自动升级。每个文件的 buildId、sourceCommit、大小、SHA-256 和验证范围以本工作区 `docs/downloads/2026-10-30-closeout/` 交接文件为准；旧 URL 保留，失败候选不发布。
