# Phase 03 Verification

- Date: 2026-07-23
- Target branch: `codex/mqtt-monorepo-restructure`
- Baseline HEAD: `4de1aa4`
- Gate verdict: **PASS**

## Scope Verified

Phase 03 delivers the Electron MQTT runtime and its native lifecycle. Verification covers the shared packages, Electron unit boundaries, manifest and preload boundaries, the production renderer build, a real Electron process, temporary user data, SQLite creation, history-window open and close, lint, and whitespace.

The smoke test launches the Electron executable against `apps/electron`, loads the built renderer from `apps/electron/dist/index.html`, and supplies a new absolute temporary `userData` directory. Its child environment explicitly removes inherited `VITE_DEV_SERVER_URL` and `ELECTRON_RUN_AS_NODE` overrides, so the smoke cannot silently switch to a development server or Node mode. It waits for the exact `mqtt-tool-ready`, `mqtt-tool-history-opened`, and synchronously written `mqtt-tool-history-closed` markers, rejects preload/navigation/renderer errors, verifies `ineed-mqtt.db` in the temporary profile, and requires exit code 0. The test uses a separate POSIX process group and signals that group even when its leader has exited but descendants still hold inherited pipes; on Windows it runs `taskkill /PID <pid> /T /F` with a bounded timeout and contained direct-kill fallback. Both paths accept cleanup completion only after the child `close` event. A hard close deadline rejects cleanup after bounded TERM/KILL waits on POSIX or when `taskkill` reports success but Electron's inherited pipes remain open on Windows. Every platform also uses a 25-second test deadline, bounded captured output, and temporary-profile removal.

## Fresh Checkout Gate

A fresh checkout needs the locked npm dependencies before running. A headless Linux runner also needs `xvfb-run` (for example, the Debian/Ubuntu `xvfb` package); the smoke test selects it automatically when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set:

```bash
npm ci
npm run verify:electron
```

The root gate expands to:

```bash
npm run test:shared
npm run test:electron
npm run lint
npm run build -w @ineed-mqtt-tool/electron
npm run test:electron:boundary
npm run test:electron:smoke
git diff --check
```

The smoke command appears exactly once. The boundary suite runs after the production build so its asset references are valid in a clean checkout.

## Toolchain

```text
Node v26.5.0
npm 11.17.0
Electron 43.2.0
Vite 8.1.5
Darwin 25.5.0 arm64
```

## Automated Test Evidence

| Gate | Result |
| --- | --- |
| `npm run test:shared` | 190 tests, 190 passed, 0 failed |
| `npm run test:electron` | 113 tests, 113 passed, 0 failed |
| `npm run test:electron:boundary` | 12 tests, 12 passed, 0 failed; invalid startup exited in 141 ms |
| `npm run test:electron:smoke` | 10 tests, 10 passed, 0 failed; real Electron completed in 577 ms |
| `npm test` | 331 tests, 331 passed, 0 failed |
| `npm run lint` | 0 errors, exit 0 |
| `git diff --check` | no output, exit 0 |
| `npm run verify:electron` | complete gate exit 0 |

The requested focused command also passed with 22 tests collected, 22 passed, and 0 failed in 615 ms:

```bash
node --test apps/electron/tests/electronSmoke.test.js apps/electron/tests/electronBoundary.test.js
```

## Renderer Build Evidence

Vite transformed 58 modules and wrote the Electron renderer to `apps/electron/dist`:

| Asset | Size | Gzip |
| --- | ---: | ---: |
| `dist/index.html` | 0.39 kB | 0.27 kB |
| `dist/assets/index-DHKhb2tR.css` | 41.13 kB | 7.39 kB |
| `dist/assets/index-ujUWFHW-.js` | 526.50 kB | 173.49 kB |

Vite reports its known warning that the JavaScript chunk exceeds 500 kB after minification. The warning does not fail the build and is an optimization follow-up rather than a Phase 03 correctness blocker.

## TDD Evidence

The initial focused RED run collected 6 tests: 4 passed and 2 failed. The database boundary failed with `TypeError: defaultDatabasePath is not a function`; the real Electron smoke reached its strict 25-second timeout with no marker output because Electron 43 loads the app main through `default_app.asar`, so `require.main === module` did not start bootstrap.

After exporting the path constructor and making the Electron default-app browser process an explicit bootstrap entry, the boundary passed and smoke reached the built renderer. Later RED runs exposed the close and exit sequencing constraints. Quality-review tests produced a further RED with 7 failures covering non-default browser imports, synchronous marker output, invalid history kinds, Windows paths, and Windows process trees. Three follow-up RED cases then proved that missing history was accepted, Windows cleanup could skip `taskkill` after browser exit, and successful `taskkill` could silently return while `close` remained pending.

The next real-process RED launched Electron with a blank history request and reached its three-second timeout even though stderr contained `INEED_SMOKE_HISTORY must be messages or logs`. This proved that setting `process.exitCode = 1` did not stop Electron's event loop after an early smoke startup failure. The smoke-only top-level failure path now writes the startup diagnostic synchronously to stderr and calls `process.reallyExit(1)`; the production failure path remains unchanged.

The final quality-review RED used a real detached POSIX group whose leader exited while a descendant retained its output pipes. Cleanup returned with `close` still false because it treated the leader's `exitCode` as completion. A second RED proved that a permanently pending `close` produced no rejection or group signals, and a close-gate RED showed that a child `error` was also incorrectly treated as completion. POSIX cleanup now signals the group regardless of leader exit, waits a bounded interval after TERM, repeats with KILL, and rejects explicitly if `close` remains pending. Only the actual `close` event completes the shared gate. The final focused GREEN run passed all 22 tests, including invalid startup exit status 1, POSIX and Windows hard close gating, and the real renderer child with exit code 0.

## Smoke Exit Boundary

The test path is enabled only when `INEED_SMOKE_TEST=1`. It applies the supplied absolute `INEED_SMOKE_USER_DATA`, requires exactly `messages` or `logs` as the history request before database/window startup, observes runtime failures, and coordinates cleanup only after the history renderer has completed both of its initial database IPC operations. Main auto-bootstrap is limited to the actual entry module or Electron's `process.defaultApp === true` browser process; imports from other browser processes remain side-effect free.

Production shutdown is unchanged: disconnect MQTT, flush pending messages, close the database, dispose MQTT batching, remove IPC handlers, dispose the close controller, destroy the main window, then call `app.quit()`.

On Electron 43/macOS, observed `BrowserWindow` destroy calls set `isDestroyed()` to true but do not deliver the JavaScript `closed` event, and `app.quit()`, `app.exit()`, and Electron's intercepted `process.exit()` do not terminate after that state. The smoke harness therefore runs the same six cleanup phases, explicitly destroys and verifies the tracked history and main windows, synchronously writes the closed marker to stdout, and only then calls Node's native `process.reallyExit(0)`. Boundary tests prove the gate cannot exit unless smoke mode is enabled, cleanup is complete, history is destroyed, main destruction succeeds, and the marker write is attempted before exit; marker write failures are reported without bypassing cleanup. This fallback is unreachable from production behavior and cannot skip resource or window cleanup.

## Final Verdict

**PASS**: shared and Electron tests pass, the production renderer builds, the preload and persistence boundaries match the manifest, a real Electron process loads both main and history renderers without runtime errors, the temporary database is created under `userData`, all resources and windows are cleaned, and the verification leaves no task-owned Electron, Vite, Playwright, or MQTT process behind.
