# 界面时间显示

三款 Ineed Tool 及未来 Tool 采用同一显示规则；本产品实现入口为 `packages/workbench/src/workspace/timeFormat.js`（核心）与 `historyTime.js`（历史兼容）。独立仓库不通过工作区外部路径导入其它产品源码。规则与 LinkLab 的 `packages/workbench/src/model/dateTime.js` 对齐。

- 默认显示本机时区 `YYYY-MM-DD HH:mm:ss.SSS`，固定补齐毫秒，不依赖系统语言或地区格式。
- 紧凑实时列表、图表时间轴可使用 `HH:mm:ss.SSS`；详情或悬停提供完整日期。历史与详情默认保留完整日期。
- 核心 formatter 接受安全整数毫秒或显式带 `Z` / `±HH:mm` 时区的 ISO 日期时间。epoch 0 有效；缺失、负值、非整数、无时区字符串和无效日期显示 `--`。
- 显示转换不修改协议、存储、原始导出、文件名、应用身份或数据目录。持续时长、延迟、TTL、倒计时和日期输入控件沿用各自语义。

## 兼容现有安装

- SQLite 的 `created_at` 仍写既有本地日期时间字符串，`toHistoryTimestamp()` 的契约不变；历史显示适配只接受严格有效的旧本地格式，并补齐已有秒值的小数位。旧本地值未保存来源时区，保留原墙钟字段，不根据当前时区的夏令时缺口否定已有日期，也不推测来源时区。显式带时区的 ISO 记录转本机时区。
- 旧历史仅有 `HH:mm:ss[.SSS]` 时显示 `HH:mm:ss.SSS`；这类记录没有保存日期，不补造日期；列表悬停与详情标明“旧记录无日期”。
- 已保存的 `timestampFormat` 字段及旧 relative/absolute/iso 值继续读取和保存，实际界面遵循固定规则；设置页改为规则说明。实时消息和日志在内存保留完整显示时间，列表紧凑显示并提供完整 `title`；消息详情、复制日志及历史详情保留完整已有日期。旧日志 `time` 列继续按已保存的 absolute（仅时钟）或其它旧模式（完整日期）写入，兼容适配仅发生在入库边界，不改变 `created_at`。

## 验证入口

`npm test`、`npm run test:components`、`npm run lint`、`npm run build:renderers`。界面矩阵 `npx playwright test -c packages/workbench/playwright.typography.config.js typography.spec.js` 覆盖 Electron/Tauri 渲染入口、Chromium/WebKit、三种窗口和普通/大字模式；浏览器预览不代表原生 MQTT 或安装包验收。
