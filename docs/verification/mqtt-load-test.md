# MQTT Load Verification

Fresh run: 2026-07-23T23:59:02.438Z

Plan SHA-256: `32e46aa5ff6fe51195b7d163f020a7b960f5c23c802186c467674d77de6fe303`

Plan: `{"connections":2,"topicsPerConnection":10,"payloadBytes":1024,"totalMessages":10000,"nativeEventBatch":200,"persistenceBatch":200,"queueMax":2000,"realtimeMaxPerConnection":300,"retryCount":3,"publishConcurrency":16,"publishRatePerSecond":4000,"timeoutMs":120000,"rssGrowthLimitBytes":268435456}`

Source SHA-256:

- `tooling/mqtt-load-test/loadPlan.mjs`: `562e6346fc8e66bf9514503080110296d33691052a466825d21b09bb8aaa510a`
- `tooling/mqtt-load-test/loadRunner.mjs`: `b2034ad5ce0e9b3c3438fb0501eee64b6852e23a83edd18a573db691c3699b7f`
- `tooling/mqtt-load-test/electronHarness.mjs`: `ffd35d206c076fbe39e0a52d28387f151729531ea506f5ab853b7f04bcee67ae`
- `tooling/mqtt-load-test/tauriHarness.mjs`: `ef1c18118f45919d0862decaff268d8c3ca23197e9cfbda3e17497308d94078e`
- `apps/tauri/src-tauri/src/bin/mqtt_contract_harness.rs`: `64e330bcc2d66f4279bad919abf34dc465a406b30f770f4f21c50dae8e6f8f3d`
- `packages/workbench/src/workspace/batchedPersistence.js`: `a0aa5a361d4551e342185b5998882bfb7abd61de194b608d366238023ea91ae4`
- `packages/workbench/src/workspace/realtimeItems.js`: `236ecb430fe78d6b18a7bd1276e01f7f44d2ad41b710d7b1de2f979a6ce93f2b`
- `apps/electron/electron/main.cjs`: `37ca7b46de5bcdb8f3010789772ddedb53dde8a55e7617f9e21ec67e4364c3a6`
- `apps/electron/electron/database.cjs`: `13f36d818a0a2bb067cdf2c17047d1ce1083440dbc7f193f6d9acdf82ed05d0b`
- `apps/tauri/src-tauri/src/mqtt.rs`: `6565a483a9a0046ec84ed01be2cdbf59eb06d0429363d4cebdd08bfb4f021840`
- `apps/tauri/src-tauri/src/database.rs`: `2ea50d5f2448082a7db82fbdd95ea44ab0a83e98bfbf8fc073f7508707801600`
- `packages/mqtt-contract/src/index.js`: `ad4e2e3b4dcfb906f3ab696c514432150c6ee4ca783f893fda46dff64f829fe8`
- `package-lock.json`: `eed1aa5df1966c402b94d00647f393aee76574b2fb287f83e4842c1cd9ddae47`
- `apps/tauri/src-tauri/Cargo.lock`: `a6b4b20d1630ad0b1a865a4f390dfa4e0bdb495bd8accc3b0a34e8a09aac41ca`

Environment: Node v26.5.0; npm 11.17.0; rustc 1.96.1 (31fca3adb 2026-06-26); cargo 1.96.1 (356927216 2026-06-26); darwin 25.5.0; arm64; dirty=false; implementation commit `9e4f6d955b65397ce2b9df9d1ae8e0bb65847d9c`.

RSS scope: `total-harness-runtime`. Electron measures the Node runner containing broker, publisher, shared queue/realtime state, database, and coordinator. Tauri measures that same Node runner plus the live Rust child process. Every baseline, periodic, and final sample is required; an unavailable or invalid sample fails the gate.

Windows coverage: PowerShell RSS command construction/parsing and process-tree termination are unit-tested. Native Windows integration evidence requires a Windows run.

| Runtime | Messages | Duration | Throughput | Native max | Persist max | Peak queue | Retries | Dropped | Total RSS before / peak / after | DB bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| electron | 10000 | 2553 ms | 3916.4 msg/s | 200 | 200 | 200 | 0 | 0 | 68.17 MiB / 261.95 MiB / 261.95 MiB | 18313488 |
| tauri | 10000 | 3951 ms | 2530.8 msg/s | 200 | 200 | 200 | 0 | 0 | 277.33 MiB / 304.03 MiB / 304.03 MiB | 15906096 |

Overall duration: 6631 ms.
