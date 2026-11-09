# Message Scenarios Implementation Plan

> Execute inline with superpowers:executing-plans; user authorized original-directory edits, no agents, commits or publishing.

**Goal:** Deliver reusable, correlated MQTT JSON device scenario checks and bounded evidence.
**Architecture:** Shared domain validation + shared runner + existing subscription lifecycle lease + settings-backed repository + one Vue workbench panel.
**Tech Stack:** Vue 3, JavaScript, existing runtime facades, Node test, Vitest, Playwright, Aedes.
**Spec:** docs/superpowers/specs/2026-10-31-message-scenarios.md

## Global Constraints

Preserve docs/form-layout.md and packages/workbench/e2e/formLayout.spec.js existing edits. Original source directory only. No SQLite schema migration. No arbitrary scripts. No MQTT5/Will/replay/heartbeat claims. No credentials from connection exports. Local loopback isolated tests only. No commits/publishing.

### Task 1: Model, library and reports

Files: packages/domain/src/messageScenario.js, packages/domain/tests/messageScenario.test.js, packages/workbench/src/workspace/scenarioRepository.js, packages/workbench/tests/scenarioRepository.test.js.
Interfaces: normalizeScenario(input), prepareScenario(scenario, requestId), evaluateAssertions(json, assertions), createScenarioRepository(db) with load/save/remove/import/export/saveReport.
- [x] Write failing tests for whitelist, safe paths, JSON template escaping, equals/type/range, invalid import and write failure: `assert.throws(() => normalizeScenario({...scenario, correlationPath:'__proto__.id'}))`.
- [x] Run `node --test packages/domain/tests/messageScenario.test.js packages/workbench/tests/scenarioRepository.test.js`, confirm missing-feature failure.
- [x] Implement normalized versioned whitelisted records, bounded serialized settings and import preview.
- [x] Rerun focused tests.

### Task 2: Run and subscription ownership

Files: packages/workbench/src/workspace/scenarioRunner.js, packages/workbench/src/workspace/subscriptionLifecycle.js, packages/workbench/tests/scenarioRunner.test.js, packages/workbench/tests/scenarioLease.test.js.
Interfaces: createScenarioRunner({mqtt, withResponseSubscription, onReport}) returning start(scenario, connection), stop(), acceptMessages(batch), connectionStatus(id,status). Lifecycle withResponseSubscription({connId,topic,isCancelled}, work) waits SUBACK and releases only owned filter.
- [x] Write failing tests: defer subscribe; assert publish count zero; stop then resolve ACK; assert zero publishes and cleanup. Response inside publish callback must pass despite pending PUBACK. Retain and previous request must timeout. Same saved filter must never unsubscribe.
- [x] Run focused Node tests to observe missing behavior.
- [x] Implement one run identity, bounded evidence and deadline; durable lease intent and current socket checks under existing queue.
- [x] Run focused tests plus actual Aedes integration with loopback temporary port and close all clients/server.

### Task 3: Workbench panel

Files: packages/workbench/src/components/ScenarioPanel.vue, packages/workbench/src/styles/scenarios.css, packages/workbench/src/layouts/MqttToolShell.vue, packages/workbench/tests/components/scenarioPanel.test.js, packages/workbench/e2e/scenarios.spec.js.
- [x] Write component interaction tests for save/import/execute and report; run Vitest failing first.
- [x] Implement accessible labeled editors and import preview, explicit run/stop/report actions using shared repository and runner. Shell forwards raw incoming messages and connection status; close stops runner before draining tracked operations.
- [x] Run components and both renderer e2e display matrix using isolated preview fixture.

### Task 4: Verify and document

Files: docs/message-scenarios.md, README.md, workspace tasks/2026-10-31-mqtt-scenarios.md (no STATUS edits).
- [x] Run `npm run test:shared`, `npm run test:components`, `npm run test:electron`, `npm run test:tauri`, `npm run lint`, `npm run build:renderers`, selected Playwright matrix and `git diff --check`.
- [x] Record precise evidence, native/preview boundaries and all remaining limits. Review diff and initial unrelated edits before reporting.

## Completion evidence

Shared349, components112, Electron143, Tauri49; real native MQTT scenario2; dual renderer/browser UI68 plus final JSON export4; lint, both renderer builds and diff check pass. No commits, packaging or release. Tauri exports inspectable JSON/native clipboard text; Electron additionally downloads a JSON file. Runtime native GUI/clipboard and installers are separate unverified boundaries.
