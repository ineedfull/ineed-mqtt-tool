# Phase 04 Tauri Verification

## Environment

Evidence below was collected from a fresh run on 2026-07-24.

| Item | Value |
| --- | --- |
| Host | macOS 26.5.2 (25F84), arm64 |
| Node.js / npm | 26.5.0 / 11.17.0 |
| Rust / Cargo | 1.96.1 / 1.96.1 |
| Tauri Rust crate | 2.11.5 |
| Tauri JavaScript API | 2.11.1 |
| Clipboard plugin | Rust 2.x locked by Cargo, JavaScript 2.3.2 |
| Renderer builder | Vite 8.1.5 |

## Gate

The root command is:

```sh
npm run verify:tauri
```

It runs, serially: shared Node tests, all non-smoke Tauri JavaScript tests, ESLint, the Tauri renderer build, `cargo fmt --check`, locked Cargo check, locked Rust tests, a locked debug build, one Tauri smoke suite, and `git diff --check`. The smoke suite then performs fresh renderer and locked Cargo builds with `TAURI_CONFIG={"build":{"devUrl":null}}`. Cargo uses `--message-format=json-render-diagnostics`; the harness parses the current build's JSON stream and accepts exactly one absolute `compiler-artifact.executable` for the `ineed-mqtt-tool` bin target. This build-time override is required because a normal Cargo debug context embeds `devUrl`; it makes the directly spawned debug binary embed `frontendDist` without starting Vite.

| Verification | Fresh result |
| --- | --- |
| Shared JavaScript | 190 passed, 0 failed |
| Non-smoke Tauri JavaScript | 46 passed, 0 failed |
| Tauri smoke JavaScript | 18 passed, 0 failed |
| Rust unit tests | 56 passed, 0 failed; 0 main and 0 doc tests |
| `npm run verify:tauri` | exit 0 |
| Full `npm test` | 395 passed, 0 failed |
| Electron Node regression | 113 passed, 0 failed |
| Electron renderer regression | 58 modules built, exit 0 |
| Strict Clippy scope | exit 0 with `-D warnings -A clippy::manual_repeat_n` |

The single Clippy allow is the Phase 03 database baseline on Rust 1.96.1. Keeping `repeat(...).take(...)` avoids raising the repository's potential MSRV; no other Clippy warning was present.

## Artifacts

The fresh Tauri renderer built 64 modules and produced exactly:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `apps/tauri/dist/index.html` | 397 bytes | `344d56dd72249fa838c5c002bab96b949f3f5ba732e260da66edf24607b09bbb` |
| `apps/tauri/dist/assets/index-DHKhb2tR.css` | 41,135 bytes | `69e442d37cf52584b371a89303af2598afbe67e2b887faba88fed9ca63fa476a` |
| `apps/tauri/dist/assets/index-hA-_y_C-.js` | 530,523 bytes | `47c38cde55b4dbb41166be96ab1948a4448bb0b4903f96bc7d1850b49bae5b6b` |

The final default Cargo JSON stream reported `/Users/pangzhigang/develop/com.ineedfull/ineed-mqtt-tool/apps/tauri/src-tauri/target/debug/ineed-mqtt-tool`, 47,499,056 bytes with SHA-256 `a7c7d4a8579e054b9d7abad091a11772e4836a90000a155405d46e3ff11898aa`. With `CARGO_BUILD_TARGET=aarch64-apple-darwin`, Cargo instead reported `/Users/pangzhigang/develop/com.ineedfull/ineed-mqtt-tool/apps/tauri/src-tauri/target/aarch64-apple-darwin/debug/ineed-mqtt-tool`, 47,633,376 bytes with SHA-256 `2dee4b0f451e55c79956d4ec2c7fd73d1ec17cfbad57d6ceda4e903dcdf7bbf1`; that exact executable completed a second six-marker smoke. The native facade still registers exactly 30 invoke handlers. The default capability still contains only `core:default`, clipboard text read, and clipboard text write, scoped to the three exact application windows.

The 530,523-byte JavaScript chunk triggers Vite's non-blocking 500 kB advisory. It is the only accepted build advisory in this phase.

## Real Smoke

The smoke starts the exact executable reported by the current Cargo build, not a reconstructed `target/debug` path, not `tauri dev`, and not a Vite server. Stat, executable access, streaming SHA-256, Unix `strings` asset containment, and launch all consume that same reported path; the strings gate also rejects the embedded development URL. It resolves the platform temporary root to an absolute path before creating the application-data directory, registers recursive cleanup immediately after creation, sets `INEED_SMOKE_TEST=1` and `INEED_SMOKE_APP_DATA`, and removes inherited Tauri dev/config, Vite URL, Electron Node-mode, and smoke-fault overrides. During the final `verify:tauri`, the default success test completed in 6,950 ms with exit code 0, no signal, and empty stderr; the native no-readiness fault completed in 1,859 ms with exit code 1; the real Vue lifecycle fault completed in 1,463 ms with exit code 1; and the explicit host-target build and six-marker launch completed in 7,344 ms.

Synchronous stdout markers were exactly:

```text
mqtt-tool-database-path:isolated-smoke-profile
mqtt-tool-database-initialized
mqtt-tool-ready
mqtt-tool-shutdown
mqtt-tool-closed
mqtt-tool-default-profile-unchanged
```

`PageLoadEvent::Finished` now records native page completion only for the `main` WebView when the finished URL contains exactly one `ineedSmokeChallenge` whose decoded value exactly matches the current native random challenge. Initial unchallenged, wrong-challenge, duplicate-challenge, and history-window finished events are ignored. With the valid challenge, the renderer installs `error` and `unhandledrejection` listeners plus a Vue `app.config.errorHandler` before mount, preserving and chaining any existing handler. It wraps the adapter's real Tauri `invoke` without changing its receiver, synchronous throw/return, Promise, thenable, or rejection behavior. It mounts the workbench on `#app`, verifies Vue's `data-v-app` mount attribute, and emits `app:renderer-ready` exactly once only after both mount and at least one native invoke have succeeded. Any captured browser, bootstrap, or Vue error is terminal and prevents readiness. Error payloads expose only a fixed kind and allowlisted Error class; messages, URLs, credentials, custom names, and the native challenge are never logged.

The Vue fault fixture is enabled only when native smoke setup receives `INEED_SMOKE_FAULT=vue-lifecycle`; native then appends `ineedSmokeFault=vue-lifecycle` beside the random challenge on the main local URL. A real Vue mounted hook throws, `app.config.errorHandler` emits the bounded `app:renderer-error` payload exactly once, native writes `mqtt-tool-renderer-error:vue:Error`, no ready marker is written, and the actual process exits 1. Production never adds the fault query.

Because Tauri's application event API has no sender field, smoke setup creates a random challenge and delivers it only by navigating the main WebView to its challenged local URL. Native readiness/error listeners reject missing or different challenges, so a history WebView cannot spoof main readiness. Native state retains either ready-first or page-first races and starts shutdown exactly once only after challenged `{ mounted: true, invokeSucceeded: true }` readiness and main page completion are both present. A smoke-only 30-second native watchdog reports a fixed page-load failure and requests exit 1 when this handshake does not complete. The fault fixture shortens that timer to 500 ms and suppresses readiness acceptance; it proves stderr is populated, no ready marker is written, and the actual process exits 1.

All WebView windows are destroyed only after the handshake. The main `WindowEvent::Destroyed` produces the closed marker, then the default profile is verified and the unchanged marker is written. Only then does `AppHandle.exit(0)` end the Tauri event loop. The runner uses Tauri's documented `run_return` cleanup flow to propagate the requested smoke code as the real process code; it does not use `process.reallyExit`, an OS kill, or a new invoke command.

Before any smoke `create_dir_all` or database open, Rust obtains the platform default from `app.path().app_data_dir()`, lexically normalizes absolute paths, canonicalizes the nearest existing ancestor for a missing default, and resolves symlinks for the already-created smoke directory. Equal physical paths fail synchronously with exit 1 before database access; normal macOS `/var` to `/private/var` resolution remains valid. The resolved smoke path is used for the database open, and every exit path revalidates that the original smoke path still resolves to the same canonical identity. A unit fixture proves a symlink alias of a temporary default profile is rejected while the sentinel database's metadata and streaming hash remain unchanged; another proves a post-open-style symlink swap is detected.

Rust fingerprints the default profile's `ineed-mqtt.db`, `ineed-mqtt.db-wal`, and `ineed-mqtt.db-shm` using existence, portable metadata, and an 8 KiB streaming content hash; it never reads a whole profile file into memory or prints the path. After the main window is destroyed, the same three fingerprints must match. Pure Rust tests prove creation, same-size content modification, deletion, WAL creation, and SHM creation are all detected.

The temporary profile contained exactly `ineed-mqtt.db`. After the process closed, Node's SQLite reader reported `PRAGMA integrity_check = ok`, `PRAGMA user_version = 1`, an empty `foreign_key_check`, and exactly the six contract tables: `connections`, `logs`, `message_history`, `publish_history`, `settings`, and `subscriptions`. Rust emitted `mqtt-tool-default-profile-unchanged`; the temporary directory was removed by the already-registered final cleanup.

The harness caps combined output at 1 MiB and the native launch at 60 seconds. Timeout, output overflow, and spawn failures all enter process-tree cleanup and wait for the actual child `close` event and pipes. POSIX uses a detached process group with bounded TERM then KILL; Windows uses bounded `taskkill /T /F` with a direct-kill fallback and the same hard close gate. The final process and temporary-directory audit found no remaining Tauri binary, WebView helper, or smoke profile.

## Production Isolation

Without `INEED_SMOKE_TEST=1`, setup continues to use only `app.path().app_data_dir()`. It does not read `INEED_SMOKE_APP_DATA`, fingerprint the profile, install native renderer listeners, add a challenge or fault query, print smoke markers, schedule the watchdog, destroy windows automatically, or exit automatically. A renderer URL without one valid v4 UUID challenge uses the original Tauri `invoke` function directly, mounts normally, leaves `app.config.errorHandler` unchanged, installs no error listeners, and emits no readiness or error events; this covers production, preview, and history windows. In smoke mode the supplied path must be nonblank, absolute, and physically different from Tauri's real default before `create_dir_all` and before opening the database. Rust unit tests cover blank, relative, absolute, symlink alias, missing-default, and path-swap inputs.

## Platform Prerequisites

macOS and Windows launch Cargo's reported executable directly; no suffix or target-directory reconstruction is used. Windows cleanup requires `taskkill`.

Linux needs the standard Tauri/WebKitGTK 4.1 build and runtime dependencies, including `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev`, `libxdo-dev`, `build-essential`, and `xvfb`. When neither `DISPLAY` nor `WAYLAND_DISPLAY` is set, the harness automatically launches through:

```sh
xvfb-run -a --server-args=-screen 0 1280x1024x24 <debug-binary>
```

For a Linux runner executing as root, only that smoke child receives WebKit's required `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`; non-root and non-Linux environments explicitly remove an inherited value.

## TDD Evidence

The original focused RED command was `node --test apps/tauri/tests/tauriSmoke.test.js`: 8 tests passed and the real smoke failed at its strict 60,000 ms timeout with empty stdout and stderr. Its `finally` path removed the process group and temporary profile. After the first hook, database path and initialized markers appeared but renderer readiness still timed out. Binary inspection proved the debug context contained `http://localhost:5175`; rebuilding with the official `TAURI_CONFIG` override embedded the hashed dist assets instead.

The follow-up review started three fresh RED groups: the renderer reporter failed with `ERR_MODULE_NOT_FOUND`; smoke contracts failed because native events, the fixed stderr gate, and early temp cleanup did not exist; Rust failed to compile because lifecycle and fingerprint types did not exist. Reporter GREEN is 6 tests covering mount without invoke, invoke without mount, both race orders, duplicate suppression, rejected invoke, and terminal sanitized errors. Rust GREEN is 51 tests, including challenged main-only state and streaming DB/WAL/SHM fingerprints. Smoke GREEN is 14 tests, including relative temporary-root resolution, early cleanup registration, every required stderr spelling, the six-marker success executable, and a real watchdog fault with exit 1.

The final challenge-isolation review added focused RED before implementation. `node --test apps/tauri/tests/readinessReporter.test.js` failed because `configureRendererReadiness` was not exported; after the conditional bootstrap was added, 8 tests passed, including explicit zero-side-effect production behavior and a complete valid-challenge smoke handshake. Focused Rust compilation failed because `page_challenge_matches` did not exist and `record_page_finished` accepted no challenge; after implementation, the full Rust suite passed 53 tests. The new Rust cases prove no/wrong/duplicate URL challenges are rejected, the exact single value is accepted, an unchallenged Finished event followed by renderer readiness still waits for a challenged Finished event, and the challenged-page-first race shuts down when readiness arrives.

The swallowed-error and artifact-path review also followed focused RED to GREEN. Renderer RED showed that `configureVueApp` was missing and the async invoke wrapper lost `this`, converted synchronous returns to Promises, and converted synchronous throws to rejections; renderer GREEN is 12 tests covering production handler isolation, Vue errors before and after invoke, an existing throwing handler, duplicates, receiver preservation, synchronous outcomes, Promise rejection, and thenable fulfillment. The first real Vue fault RED still exited 0 with all six success markers; after native challenged fault delivery and the pre-mount Vue handler, it exited 1 with `mqtt-tool-renderer-error:vue:Error` and no ready marker.

Cargo parser RED failed because no JSON executable parser existed. Its GREEN tests cover diagnostic noise, unrelated library artifacts, missing and duplicate bin artifacts, and relative executables. A real `CARGO_BUILD_TARGET` host-triple build then launched Cargo's reported target-specific executable and completed all six markers. Rust RED failed because physical path canonicalization, isolation validation, and smoke identity fields did not exist. Rust GREEN is 56 tests, including missing-tail normalization, symlink alias rejection with an unchanged default database fingerprint, and detection of a swapped smoke symlink.
