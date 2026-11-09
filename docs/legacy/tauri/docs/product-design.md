# AI MQTT 桌面调试客户端

## 背景

IoT 设备开发和调试过程中，频繁需要连接 MQTT Broker、订阅 Topic、发布测试消息和监控消息流。现有调试工具（如 MQTTX）功能完善但界面较复杂，且部分场景需要同时对比多个工具。本产品定位为轻量级的 MQTT 调试客户端，聚焦核心调试场景，提供快捷高效的消息收发体验。

## 桌面版本

本应用同时提供两个桌面壳：

- Electron：`/Users/pangzhigang/develop/com.ineedfull/electron/ineed-mqtt-desk`
- Tauri：`/Users/pangzhigang/develop/com.ineedfull/tauri/ineed-mqtt-desk`

两版使用同一套 Vue 界面和数据模型。差异只在桌面运行壳，便于后续评估包体、启动速度、系统能力和部署体验。

## 信息架构

- 连接管理：Broker 列表、新建/编辑连接、协议选择（mqtt/ws）、SSL/TLS、连接/断开
- 消息监控：实时消息日志表格、按 Topic 过滤、按方向过滤（收/发）、消息详情
- 消息发布：Topic 输入、Payload 编辑器（JSON/Text/Hex）、QoS/Retain、发送历史
- 主题管理：订阅列表、Topic 树形浏览器、通配符监控、添加/取消订阅
- 调试设置：日志级别、最大日志条目、Payload 大小限制、格式化选项、自动滚动

## 界面原则

- 第一屏就是可用工作台，不做营销 landing page。
- 布局延续 short-drama 的设计系统：约 218px 左侧栏、64px 顶部栏、中间白色大面板、右侧详情面板。
- 左侧品牌使用 "MQTT Desk"，菜单覆盖连接管理、消息监控、消息发布、主题管理和调试设置。
- 配色采用绿色/蓝绿色调代表连接状态和 MQTT 协议。
- 当前阶段所有按钮和数据都是展示态，后续接入 mqtt.js 实现真实的连接与消息操作。

## 后续扩展边界

后续如果要接入真实 MQTT 业务，应接入 mqtt.js 库，通过 Electron IPC 或 Tauri 命令管理连接生命周期，前端直接调用预定义的 service 接口。当前阶段预留 mqttService.js 作为接入点，替换 mock 实现即可。
