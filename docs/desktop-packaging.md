# 桌面安装包构建与验收

Electron 的 `afterPack` 只删除渲染器专用工作区包；`mqtt-contract/endpoint` 同时供主进程连接校验使用，必须随安装包保留。清理包内测试、日志和 source map 后，仍需验证该入口可实际加载，并从最终安装包启动窗口。开发宿主能运行不能代替这项验收。对应回归见 `scripts/release-packaging.test.mjs`。

macOS 的内部 `CFBundleName` 必须与打包 `productName` 完全一致，包括大小写；Chromium 据此查找 Helper 可执行文件。对外显示仍使用 `CFBundleDisplayName` 和应用菜单中的 `iNeed MQTT Tool`。修改品牌时同时核对包内 Helper 路径并实际启动安装包。

MQTT、LinkLab、NetTool 使用相同的新命令与发布脚本，分别在各自仓库根目录执行。MQTT / LinkLab 配置 Electron / Tauri 双运行时，NetTool 只配置 Electron；产品描述中的 `runtimeDirectories` 决定实际任务。本地生成的制品在完成目标系统验收和正式签名之前属于测试安装包。

## 目标与安装体验

| 平台 | 架构 | 格式 |
| --- | --- | --- |
| Windows | x64 | NSIS 安装向导 `.exe`，默认当前用户安装 |
| macOS | arm64 / x64 | `.dmg` |
| Linux（Ubuntu / Debian） | x64 | `.deb` 与 AppImage |

Windows 安装版提供安装目录、快捷方式与卸载入口。Electron 配置普通用户安装、可选安装路径、保留应用数据；Tauri 使用 currentUser NSIS，附带离线 WebView2 安装器。WebView2 已安装时由安装器判断复用；构建机下载离线组件仍需要网络。安装器提供简体中文 / 英文。

Tauri 阻止降级安装，避免旧应用打开新数据库。正常升级必须在目标 Windows 系统检查配置、历史记录与日志保留情况。保留已有 appId / identifier / 数据路径；没有通过双运行时并存测试前，不在同一个用户配置下交替覆盖 Electron 与 Tauri。

## 命令

先安装锁文件中的依赖，构建前执行检查：

```sh
npm ci
npm run test:release
npm run lint
```

计划预览不执行编译、不创建或删除产物，任何宿主机都可查看其他平台的命令：

```sh
npm run release:plan -- --platform=windows
npm run release:plan -- --platform=linux
npm run release:plan -- --platform=macos --arch=all
```

在对应操作系统上执行：

```sh
# Windows x64，两个运行时
npm run package:win

# Ubuntu / Debian x64，两个运行时，各生成 deb + AppImage
npm run package:linux

# macOS，两个运行时，各生成 arm64 + x64 DMG
npm run package:desktop:mac
```

限定单个任务：

```sh
npm run release:build -- --platform=windows --arch=x64 --runtime=electron
npm run release:build -- --platform=macos --arch=arm64 --runtime=tauri
```

`--runtime=all` 是默认值；不填 `--arch` 时 macOS 使用当前 Mac 架构，Windows / Linux 默认 x64。当前新矩阵没有 Windows / Linux ARM64。MQTT 旧打包入口的 ia32 配置保留，但不代表已通过现代依赖与系统验收。

下载默认沿用项目的 npmmirror Electron / electron-builder 二进制镜像，可通过 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 覆盖。如果本机有已核实的官方 Electron 分发缓存，可以设置 `INEED_ELECTRON_DIST` 为包含对应 `electron-v<版本>-<系统>-<架构>.zip` 的目录；需自行确保缓存版本、架构和来源正确，不将其他版本伪装成目标版本。

所有 CLI 均通过 Node 直接运行 JS 入口，不经 `.cmd` 和 shell 字符串拼接。Electron 每次先重新构建前端；Tauri 通过现有 beforeBuildCommand 构建前端，并向 Cargo 传入 --locked，防止构建时悄悄更新依赖锁文件。

## 产物与检查

成功后终端输出 `RELEASE_DIRECTORY=...`，对应：

```text
release/desktop/<版本-时间-随机标识>/
├── manifest.json
├── build-logs/
└── <产品>-<版本>-<运行时>-<系统>-<架构>.<扩展名>
```

NSIS 文件名带 `-setup.exe`；deb 使用 `amd64` 文件名，清单统一记录 `x64`。每次构建使用独立暂存目录，同一源码树上的新流程有构建锁，成功后整体收集到新的目录，不覆盖既有发布包。不要同时运行旧打包命令或修改正在构建的源码。

```sh
npm run release:verify -- --dir=/完整路径/release/desktop/某次构建目录
```

确认测试集合后，可上传到 146 的共享私有 MinIO 桶。执行机器需能通过 SSH 免密连接 `222.71.62.146`；服务器上的当前登录账号需配置 `myminio` CLI 别名和 `ineed-downloads` 桶权限。脚本不读取或打印 MinIO 凭据。

```sh
npm run release:upload -- --dir=/完整路径/release/desktop/某次构建目录
```

上传前重新验证整个 `manifest.json` 集合；对象路径固定为 `ineed-mqtt-tool/<版本>/<buildId>/<文件名>`，与其他 Tool 隔离。已有同名对象会读取远端 SHA-256 后跳过，相同键但字节不同会报错。每个上传文件都会从 MinIO 回读大小和 SHA-256，成功后在 `release/uploads/ineed-downloads/<buildId>.json` 留下本地收据。该目录被 Git 忽略；请保留收据和原始构建清单作为交接材料。上传只代表私有存储与文件完整性通过，不代表签名、安装验收或公开发布。

Windows PowerShell 路径包含空格时，把整个 `--dir=...` 参数放进双引号。

此检查证明：预期产物齐全、格式头正确、文件大小与 SHA-256 一致、无重复或额外产物。它不会把“摘要正确”当成“应用已安装运行”：返回值始终分别列出 installation / runtime / signing 未验证。该 JSON 不是签名证明，也不能用来自行宣布正式可用。

旧 MQTT `package:all` / `verify:packages` 和 LinkLab `package:mac` / `verify:package:mac` 仍保留兼容历史证据；旧 MQTT 全内容检查器仍只覆盖 macOS。跨平台与多格式构建统一使用本文的新入口，不混用两种清单目录。

构建失败保留 `.stage-*` 中的日志，不产生成功集合。异常强杀进程可能留下 `.build-lock`，确认没有构建进程后再清理锁。暂存目录可能较大，复核日志后可以手动清理失败目录；不要删除正在构建的目录。

## 平台环境

### Windows

准备与项目兼容的 Node、Rust MSVC 工具链、Visual Studio C++ Build Tools / Windows SDK。在 x64 Windows 环境执行，验证当前用户安装、无管理员账号、中文用户名、带空格目录、开始菜单、桌面快捷方式、卸载和覆盖升级。

Tauri 离线 WebView2 模式会增大安装包。必须在无 WebView2 的干净 Windows 上断网验证，不能仅在开发机运行成功后声明离线安装可用。LinkLab 使用虚拟 COM 对或实体回环检查串口；POSIX PTY 测试不能代替 Windows COM 验收。

### macOS

准备 Xcode Command Line Tools 与目标 Rust 标准库：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

两个架构分别输出 DMG。Intel 实机验收与 Apple Silicon 上 Rosetta 启动分别记录。现有 macOS 配置仍按内部测试包处理；正式发行需要配置 Developer ID 签名、公证和 staple，并重新对最终文件生成摘要。

### Ubuntu / Debian

建议从 Ubuntu 22.04 / Debian 12 等提供 WebKitGTK 4.1 的旧支持基线构建，再在拟支持的 Ubuntu 22.04 / 24.04、Debian 12 / 13 上分别安装验证。较新系统版本另列证据，不通过改名宣称兼容。

Tauri 需要构建工具、pkg-config、OpenSSL、GTK / WebKitGTK 4.1 开发包；LinkLab 还需 libudev 开发包。按发行版实际名称安装，例如 Ubuntu 22.04 / Debian 12 的基础包：

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config curl wget file patchelf \
  libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev libudev-dev
```

Node 与 Rust 单独按项目工具链准备。Linux 原生库最低版本由构建基线决定，AppImage 也不自动消除 glibc、FUSE 等要求。不要将关闭 Electron sandbox 或以 root 启动桌面应用作为正常安装步骤。

验证 deb：

```sh
sudo apt install ./实际安装包.deb
```

检查桌面菜单、图标、启动、SQLite 迁移、普通用户网络权限与 LinkLab 串口权限。Electron 当前 Linux maintainer 使用组织名 Ineed；正式发行前填入真实维护者信息，不能编造联系邮箱。

## 验收与发布

每个 runtime / OS / CPU 单独留证：安装启动、关闭重开、升级保留数据、卸载策略、网络通信、历史记录、日志、中文路径、文件导入导出、权限与硬件串口。

MQTT 至少验证 MQTT / TLS / WS / WSS、订阅发布、主题解析、历史和日志。LinkLab 至少验证 TCP / UDP、串口、Modbus、DL/T 645 与模拟功能。浏览器模拟测试不作为原生通信验收替代。

Windows Authenticode 与 macOS 签名 / 公证尚未配置；没有证书的测试包不要标记为正式签名版。当前未发布远程仓库、CI 或公网下载，也未接入自动更新。

网站继续用 Markdown 写发行说明；只有目标系统验收通过的最终包才添加下载链接。签名后的文件重新计算摘要，并保留旧版本供回退。自动更新、更多 CPU 架构与 MSI 等格式另做后续任务。

## 应用内更新制品

MQTT 新增独立 `release:updates:plan/build/verify/upload`，在原人工安装包之外生成原生更新制品、签名和 feed；不会自动公开上传对象或发布站点清单。正式签名缺失时构建停止。配置、旧客户端引导与测试边界见 [应用内更新](in-app-updates.md)。
