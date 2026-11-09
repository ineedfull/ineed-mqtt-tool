# MQTT Tool 开发指南

[返回产品首页](../README.md) · [代码阅读地图](code-reading-map.md)

## 依赖与目录

按 `.nvmrc` 使用 Node.js 22，在仓库根目录运行 `npm ci`。npm workspaces 与 `package-lock.json` 是维护入口。Tauri 还需 Rust、Cargo 及[目标系统开发依赖](https://v2.tauri.app/start/prerequisites/)。

```text
apps/electron/   Electron 主进程、preload、原生 MQTT/数据库与适配器
apps/tauri/      Tauri / Rust 原生宿主与渲染器入口
packages/       共用 Vue 工作台、领域与运行时契约、编解码与迁移
scripts/        图标、打包、发布与更新验证
```

不要为两端复制工作台。新增能力优先进入共享领域与界面，平台差异通过适配器实现。订阅行为从[订阅生命周期](subscriptions.md)开始，连接保存与运行状态并发见[连接配置](connection-config.md)。

## 启动

Electron 桌面：

```sh
npm run dev:electron
```

根命令 `npm run dev:tauri` **仅启动渲染器预览**。真实 Tauri 开发桌面应在安装原生依赖后，从仓库根目录执行：

```sh
cd apps/tauri
npx tauri dev
```

Tauri CLI 从该目录读取 `src-tauri/tauri.conf.json`，其 beforeDevCommand 启动对应 Vite。浏览器预览不代表原生 MQTT、SQLite 或系统功能已验证。

macOS Electron 开发入口使用 `artifacts/electron-dev/` 下的品牌宿主，原生菜单显示 iNeed MQTT Tool；不修改安装的 Electron 依赖。应用身份与数据目录保持兼容，开发 ad-hoc 签名不等于正式发布签名。

## 分层验证

以下命令在仓库根目录执行：

```sh
npm run test:shared
npm run test:components
npm run lint
npm run build:renderers
```

`lint` 不接受 warning。完整运行时门禁：

```sh
npm run verify:electron
npm run verify:tauri
```

Electron 门禁包含真实窗口、系统剪贴板与本地 Broker；剪贴板专项使用临时配置并恢复原内容。订阅专项覆盖交叠订阅移除、离线清理与重启，使用隔离数据。Tauri 门禁包含 locked Cargo 检查/测试/构建与原生 smoke；首次需准备工具链与依赖缓存。

UI 与组件测试分别为 `npm run test:e2e` / `npm run test:components`，环境前提见 `packages/workbench/` 的 Playwright 配置。压力验证入口是 `npm run test:load`，参数及验收边界见[桌面长跑说明](verification/mqtt-desktop-soak.md)。测试目标使用回环服务，不读取用户真实配置。

## 图标、构建与更新

产品 SVG 在 `packages/workbench/src/assets/ineed-mqtt.svg`。品牌修改先同步统一图标源，再运行 `npm run icons:generate` 生成 PNG/ICO/ICNS；安装图标需要重新打包安装验证。

标准安装包流程为 `release:plan` → `release:build` → `release:verify`，按目标系统构建。`release:upload` 是明确的远端上传动作，不属于本地开发。旧 `package:all` / `verify:packages` 保留兼容，旧全内容校验覆盖范围见[打包说明](desktop-packaging.md)，不作为新平台验收结论。

应用内更新有独立的 `release:updates:*` 流程，Electron/Tauri 共用下载、校验与确认重启界面。正式签名材料、可信更新源和真实安装升级仍需单独验收，见[应用内更新](in-app-updates.md)。

## 数据、界面与文档

界面遵循[字号规则](typography.md)和[时间规则](date-time-display.md)。数据库迁移与已有身份必须兼容；备份完整数据前先退出应用。历史项目资料在 `docs/legacy/`，当前行为以现行源码和[功能矩阵](existing-features-acceptance.md)为准。

首页截图使用隔离数据，更新流程及来源在[图片维护](images/readme/README.md)。
