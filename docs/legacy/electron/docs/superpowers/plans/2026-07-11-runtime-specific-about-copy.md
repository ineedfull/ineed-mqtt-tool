# Runtime-specific About Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Electron and Tauri About pages accurate, runtime-specific product copy, then build and package the latest code for both applications.

**Architecture:** Keep the existing About layout unchanged and place runtime identity directly in each project's Vue template. Add source contract tests so Electron cannot mention Tauri and Tauri cannot claim it uses mqtt.js.

**Tech Stack:** Vue 3, Node.js test runner, Vite, Electron Builder, Tauri/Rust

---

### Task 1: Add Runtime-specific Copy Contracts

**Files:**
- Create: `/Users/pangzhigang/develop/com.ineedfull/electron/ineed-mqtt-desk/tests/aboutCopy.test.js`
- Create: `/Users/pangzhigang/develop/com.ineedfull/tauri/ineed-mqtt-desk/tests/aboutCopy.test.js`

- [ ] **Step 1: Add failing Electron assertions**

Read `src/layouts/MqttDeskShell.vue` and assert that it contains `运行环境：Electron`, `基于 Vue 3 + Electron 构建`, and `MQTT 通信：mqtt.js`, while excluding `双桌面壳` and `Tauri` from the About section.

- [ ] **Step 2: Add failing Tauri assertions**

Read `src/layouts/MqttDeskShell.vue` and assert that it contains `运行环境：Tauri`, `基于 Vue 3 + Tauri / Rust 构建`, and `MQTT 通信：Rust 原生实现`, while excluding `双桌面壳` and `mqtt.js` from the About section.

- [ ] **Step 3: Run focused tests and verify failure**

Run `node --test tests/aboutCopy.test.js` in each project. Expected: both fail against the shared old copy.

### Task 2: Update Both About Sections

**Files:**
- Modify: `/Users/pangzhigang/develop/com.ineedfull/electron/ineed-mqtt-desk/src/layouts/MqttDeskShell.vue`
- Modify: `/Users/pangzhigang/develop/com.ineedfull/tauri/ineed-mqtt-desk/src/layouts/MqttDeskShell.vue`

- [ ] **Step 1: Replace Electron copy**

Use the approved Electron lines: `运行环境：Electron`, `基于 Vue 3 + Electron 构建`, `MQTT 通信：mqtt.js`, protocol support, and SQLite persistence.

- [ ] **Step 2: Replace Tauri copy**

Use the approved Tauri lines: `运行环境：Tauri`, `基于 Vue 3 + Tauri / Rust 构建`, `MQTT 通信：Rust 原生实现`, protocol support, and SQLite persistence.

- [ ] **Step 3: Run focused tests and verify success**

Run `node --test tests/aboutCopy.test.js` in each project. Expected: both pass.

### Task 3: Verify Both Projects

**Files:**
- No source changes expected.

- [ ] **Step 1: Run full Electron tests and build**

Run `npm test` and `npm run build`. Expected: all tests pass and Vite creates `dist` successfully.

- [ ] **Step 2: Run full Tauri tests and build**

Run `npm test` and `npm run build`. Expected: all tests pass and Vite creates `dist` successfully.

### Task 4: Produce Clean Release Packages

**Files:**
- Replace generated contents under `/Users/pangzhigang/develop/com.ineedfull/electron/ineed-mqtt-desk/release`
- Replace generated contents under `/Users/pangzhigang/develop/com.ineedfull/tauri/ineed-mqtt-desk/release`

- [ ] **Step 1: Package Electron**

Run `npm run dist`. Expected: the release orchestrator clears the old release directory, builds supported Electron targets, wraps deliverables in timestamped ZIP archives, and removes intermediate products.

- [ ] **Step 2: Package Tauri**

Run `npm run dist`. Expected: the release orchestrator clears the old release directory, builds supported local Tauri targets, wraps deliverables in timestamped ZIP archives, and removes intermediate products.

- [ ] **Step 3: Validate artifacts and timestamps**

List each release directory, verify every deliverable is a ZIP, inspect archive integrity with `unzip -t`, and report the package timestamp and file sizes.

## Repository Note

The Electron and Tauri project directories are not Git repositories, so commit steps are not applicable.
