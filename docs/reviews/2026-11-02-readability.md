# MQTT Tool 可读性审查与整理（2026-11-02）

## 范围与结果

本轮沿消息场景的界面、领域校验、执行、订阅清理和设置持久化阅读，并检查消息区/发送区遗留样式。主要修改共享 packages；Electron/Tauri 沿用同一实现。本轮不是所有原生协议或安装包的重新验收。

| 阅读障碍或问题 | 处理与维护边界 |
| --- | --- |
| 场景面板多状态和动作压缩在一行，通用名称难区分草稿、导入与历史 | 状态与动作改为业务命名，展开错误与异步分支；模板字段及持久化名称保持原契约 |
| 场景执行的业务结束与资源结束容易混淆 | `finishRun`、`hasRunExpired`、`recordEvidence`、`publishReportSnapshot` 明确步骤；业务结果结束后仍等待订阅清理，迟到 ACK 仅参与清理 |
| 场景库保存/导入重复检查大小 | `validateLibrarySize` 集中约束；写盘成功后才替换内存快照 |
| 旧消息详情、方向小图标及发送侧栏等 CSS 已没有生产调用 | 删除13条无引用规则；保留动态方向/状态类、参考渲染器 fixture 和兼容逻辑 |

## 已复现并修复的缺陷

- P2：文件导入设置 JSON 与预览后，默认异步文本 watcher 会在下一轮把刚生成的预览清空。现在文本变更同步使旧预览失效，随后构建本次预览；文件读取有修订号，旧文件读取或卸载后的结果不再回填。读取失败在原有错误区展示。
- P2：场景 `load()` 先发出、`save()` 后完成时，迟到的旧加载能把内存列表恢复为空。加载纳入与写入相同的串行队列，失败不会阻塞下一个操作。

两项均在修改前得到失败复现。回归另检查导入条目名称、用户编辑变量进入保存/执行参数，以及文件迟到时保留新输入。没有变更 MQTT ACK、报告格式、`mqtt.scenarios.v1` / `mqtt.scenarioReports.v1` 或已有数据库结构。

## 验证

源码根目录执行：`npm run test:shared` 350通过，`npm run test:components` 114通过；`npm run lint`、`npm run build:renderers` 和 `git diff --check` 通过。

`npx playwright test -c packages/workbench/playwright.scenarios.config.js` 68通过，覆盖Electron/Tauri入口 × Chromium/WebKit，以及浅深色、普通/大字、侧栏展开/折叠、1440/920窗口。共享测试含实际Electron/Rust MQTT服务的本地受控broker契约；场景浏览器用例使用fixture，不能计作Tauri原生桌面GUI。

`npx playwright test -c packages/workbench/playwright.typography.config.js composer.spec.js subscriptionChat.spec.js` 44通过，覆盖两入口/两引擎的消息区、订阅、发送、定时及高度保存；截图已复查。本轮没有重新运行长时压力、安装包或Windows/Linux实机；未提交、打包或发布。

阅读入口：[代码阅读地图](../code-reading-map.md)。
