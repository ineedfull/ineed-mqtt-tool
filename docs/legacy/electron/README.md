# Ineed MQTT Desk

MQTT 调试客户端桌面应用，用于 IoT 设备开发与消息验证。

## 功能

- **连接管理** — 多 broker 配置，连接/断开、协议选择（mqtt/ws）
- **消息监控** — 实时消息日志，按 Topic/方向过滤，详情查看
- **消息发布** — JSON/Text/Hex 多种 Payload 格式，QoS/Retain 控制
- **主题管理** — 订阅列表，Topic 树形浏览器，通配符支持
- **调试设置** — 日志级别、Payload 大小限制、格式化选项

## 开发

```bash
# 安装依赖
npm install

# 启动 Vite 开发服务器
npm run dev

# Electron 开发模式
npm run electron:dev

# 运行测试
npm test
```

## 桌面版本

- Electron：`electron/main.cjs`
- Tauri：位于 `tauri/ineed-mqtt-desk`

## 技术栈

Vue 3 + Vite + Electron / Tauri
