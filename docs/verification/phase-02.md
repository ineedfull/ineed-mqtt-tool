# Phase 02 Verification

- Date: 2026-07-23
- Target branch: `codex/mqtt-monorepo-restructure`
- Baseline HEAD: `81d4f26`
- Gate verdict: **PASS**

## Scope Verified

Phase 02 delivers the shared Vue MQTT workbench in both renderer hosts. Verification covers the shared runtime boundary, component behavior, the Electron Vite preview in Chromium, renderer production builds, lint, and whitespace.

The browser smoke uses a deterministic in-page runtime adapter. It exposes two connections, two subscriptions, empty history pages, stable settings and storage statistics, no-op event unsubscriptions, and successful MQTT commands. It never connects to a broker or another external service.

## Fresh Checkout Gate

A fresh checkout needs the locked npm dependencies and Playwright Chromium before running the gate:

```bash
npm ci
npx playwright install chromium
npm test
npm run test:components
npm run test:e2e
npm run build:renderers
npm run lint
git diff --check
```

The final implementation gate was also run in the requested serial form:

```bash
npm test && npm run test:components && npm run test:e2e && npm run build:renderers && git diff --check
```

## Toolchain

```text
Node v26.5.0
npm 11.17.0
Playwright 1.61.1
Chromium project: channel chromium, Chrome for Testing 149.0.7827.55, build 1228
```

The Playwright project uses only Chromium. Its web server runs the Electron Vite renderer on `http://127.0.0.1:5173` with a strict port and does not reuse an existing server. Playwright owns and terminates that server for each run.

## Automated Test Evidence

| Gate | Result |
| --- | --- |
| `npm test` | 195 tests, 195 passed, 0 failed |
| `npm run test:components` | 6 files, 49 tests, 49 passed |
| `npm run test:e2e` | 2 Chromium tests, 2 passed |
| `npm run lint` | 0 errors, exit 0 |
| `git diff --check` | no output, exit 0 |

The browser tests cover both `/` and `/?history=messages`. The main workbench assertions cover both connection records, both subscription records, message and log tabs, subscription actions, the publish topic/editor/send controls, settings, and storage statistics. The history view asserts both connection filters, message filters, empty results, and a zero total.

Both browser scenarios collect `pageerror` events and console errors. Both collections were empty, including no `Ineed MQTT runtime adapter was not provided` error.

## Browser TDD Evidence

The browser workflow was written before the preview fixture and Playwright config. Its RED run failed at test collection with exit 1:

```text
$ npx playwright test packages/workbench/e2e/workbench.spec.js --reporter=line
Cannot find module 'packages/workbench/e2e/fixtures/previewAdapter.js'
No tests found.
exit 1
```

After adding the complete browser-side adapter, Chromium config, and workspace script routing, the root command passed:

```text
$ npm run test:e2e
Running 2 tests using 1 worker
2 passed
exit 0
```

The adapter factory itself is passed to `page.addInitScript`; all functions are created inside the browser rather than serialized from Node. Before installation it validates every required runtime method, including `mqtt.unsubscribe`, `lifecycle.onBeforeClose`, `update.check`, and `window.openExternal`.

## Renderer Build Evidence

Both renderer builds transformed 56 modules and completed successfully:

| Renderer | HTML | CSS | JavaScript | Gzip JavaScript |
| --- | ---: | ---: | ---: | ---: |
| Electron | 0.39 kB | 41.13 kB | 522.20 kB | 171.96 kB |
| Tauri | 0.39 kB | 41.13 kB | 522.20 kB | 171.96 kB |

Vite reports its known warning that the 522.20 kB JavaScript chunk exceeds 500 kB after minification. The warning is unchanged for both renderers and does not fail the build. Code splitting remains follow-up optimization work rather than a Phase 02 correctness blocker.

## Final Verdict

**PASS**: the shared MQTT workbench passes Node, component, and browser workflows; both renderers build; lint and whitespace checks are clean; and browser smoke runs without external broker traffic, runtime adapter errors, or a lingering Playwright/Vite process.
