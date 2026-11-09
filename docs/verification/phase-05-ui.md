# Phase 05 UI parity verification

## Result

The managed reference renderer, monorepo Electron renderer, and monorepo Tauri renderer were rendered in the same Chromium engine with the same deterministic runtime and font fixtures. All six states passed the pixel, geometry, overflow, text-fit, font-load, nonblank-image, and browser-error gates.

- Verified implementation base commit: `03a311f9d3b37bf6cf637b53b121930a2fa22ca1`; lifecycle and metrics hardening is included in the commit containing this report.
- Reference source identity: `docs/verification/reference-manifests/electron.sha256` (86 entries)
- Reference manifest SHA-256: `cda4c12e53f364e22fdbd35ff79cf82dd5204de00dff7ace2aa3a74618bfb357`
- Reference package-lock SHA-256: `929db6c41ee951c18bb412780f7ae237977c2f5276db16e10c4c4f7a0e80a6e0`
- Renderer dependency closure: 127 packages, SHA-256 `39f2d91a451425d8663a9ef06895714f0518e2a8ad5e30f659f2bd4ee9ee60ae`
- Managed reference metadata SHA-256: `2732af6a3802504efdb9afa55a5380c5028fd998babb22d87c8eeb4ccd0505e0`
- Managed reference location: `packages/workbench/e2e/fixtures/reference-renderer`
- Browser: Chromium `149.0.7827.55` on `darwin`
- Viewport: `1360x860`, DPR `1`, light color scheme
- Locale/timezone: `zh-CN`, `Asia/Shanghai`
- Evidence config SHA-256: `806a92fb4da2bfbbded018e902834a4b73765d7a08bf24524e79ed1db373ce7d`
- Evidence aggregate SHA-256: `6666aa13298ea8972627c0103645d2335dad19881c6920ae43b5e4d0c3349f06`

The reference has no required machine-specific path. With no environment variable, visual tests serve the verified managed build. When `VISUAL_REFERENCE_ROOT` names an existing manifest-matching source, the test copies it to a private temporary directory, validates the reference's installed renderer closure, and links only that reference's own `node_modules` when every package version is exact. Otherwise it runs `npm ci --ignore-scripts` inside the temporary copy. It then revalidates the copied source manifest, performs a fresh build, and requires the complete artifact file set, sizes, and hashes to match the managed fixture before capture. A missing or manifest-mismatching explicit path falls back to the managed fixture.

The managed fixture was built from the exact reference lock with Vite `8.1.4`. Its metadata records the source manifest, lock and dependency closure identities, and four build artifact hashes. No reference `.vue` source is copied into either app renderer.

## Fixed fonts

All three visual servers expose the same `/__visual_fonts/` route and inject the same `@font-face` CSS. UI text uses `Visual Noto Sans SC`; monospace and CodeMirror text use `Visual Roboto Mono`. Every capture awaits `document.fonts.load()` and `document.fonts.ready`, checks both faces, and verifies exact computed DOM families.

- Font metadata SHA-256: `10a03d3e5570c57f0a4270aad24b18d073fa5279772e4046b616495cd6e49227`
- CSS SHA-256: `207920ae8b718f866dad880e7295ee5c994d33c622820f61fbaffe0b52821436`
- UI source: `@fontsource-variable/noto-sans-sc@5.3.0`, 14 selected CJK subsets plus Latin
- Mono source: `@fontsource-variable/roboto-mono@5.3.0`, Latin variable WOFF2
- License: SIL Open Font License 1.1; both redistributed license texts, npm source URLs, package integrity values, and every asset hash are recorded in `packages/workbench/e2e/fixtures/fonts/metadata.json`

## State metrics

| State | Reference -> Electron | Reference -> Tauri | Electron -> Tauri | Max box delta |
| --- | ---: | ---: | ---: | ---: |
| Main messages | 1 px (0.000085%) | 1 px (0.000085%) | 0 px | 0 px |
| Logs | 1 px (0.000085%) | 1 px (0.000085%) | 0 px | 0 px |
| Connection dialog | 1,207 px (0.103198%) | 1,207 px (0.103198%) | 0 px | 0 px |
| Settings | 39 px (0.003334%) | 39 px (0.003334%) | 0 px | 0 px |
| Message history | 1,032 px (0.088235%) | 1,032 px (0.088235%) | 0 px | 0 px |
| Log history | 708 px (0.060534%) | 708 px (0.060534%) | 0 px | 0 px |

All reference deltas remain below the unchanged `0.5%` limit. Electron and Tauri are pixel-identical in every state, and every corresponding DOMRect is identical. The connection-dialog difference remains localized to the target focus ring; the smaller history and settings differences are raster-level differences between the legacy reference build and the target while using the same verified font files. No threshold was widened.

## Screenshot evidence

| State | Source | Dimensions | SHA-256 |
| --- | --- | --- | --- |
| Main messages | Current Electron | 1360x860 | `09de561a9ea4bf199d1a0be2f68bc250be3e3c6c29d321b05a5c63c08712b106` |
| Main messages | Monorepo Electron | 1360x860 | `02e6798accb42c8cbe0e4d76e6489a4ca7ae4035409cb9b8fa31a141a59f2afe` |
| Main messages | Monorepo Tauri | 1360x860 | `02e6798accb42c8cbe0e4d76e6489a4ca7ae4035409cb9b8fa31a141a59f2afe` |
| Logs | Current Electron | 1360x860 | `b2f126467b5c67fc8c7d855ec2ec4b6a04db8e4d8d069707a5c7b97bb2f537a4` |
| Logs | Monorepo Electron | 1360x860 | `9258d57cb8c8b724408c9f107d965cc960f3a97255419314285aa524ed46db08` |
| Logs | Monorepo Tauri | 1360x860 | `9258d57cb8c8b724408c9f107d965cc960f3a97255419314285aa524ed46db08` |
| Connection dialog | Current Electron | 1360x860 | `74fcba24529fb863c56dc215fbade84ef3966bb20c9237f4e9ebe2972b4039b0` |
| Connection dialog | Monorepo Electron | 1360x860 | `3bdaa0bb7921980a8d775c510f86b11d520673a1f31e5d033f2e17927216c459` |
| Connection dialog | Monorepo Tauri | 1360x860 | `3bdaa0bb7921980a8d775c510f86b11d520673a1f31e5d033f2e17927216c459` |
| Settings | Current Electron | 1360x860 | `6e2ffa653a4630061ac36a4f953481aaa817b71352cb63287af693e51ab09c82` |
| Settings | Monorepo Electron | 1360x860 | `5e9d95e2f26e834d171489a2165fbefd36b365e5ed9b97d5e29918cf97067e6b` |
| Settings | Monorepo Tauri | 1360x860 | `5e9d95e2f26e834d171489a2165fbefd36b365e5ed9b97d5e29918cf97067e6b` |
| Message history | Current Electron | 1360x860 | `7dd90c1886d9141f115309072e0592737788a0d9985c9a9424032930f0caf4c2` |
| Message history | Monorepo Electron | 1360x860 | `d726ab68a5691ea9f364f9ad875399484d7712cdd61f79bda7d4e78919c069ba` |
| Message history | Monorepo Tauri | 1360x860 | `d726ab68a5691ea9f364f9ad875399484d7712cdd61f79bda7d4e78919c069ba` |
| Log history | Current Electron | 1360x860 | `cb191fe9fb5add9b139ac0c523a6e8e4fc24babe85a35173cedebf6dab3b27b3` |
| Log history | Monorepo Electron | 1360x860 | `eafc6bd5d2a6d1f3e68b3b5e859a5b3d2bbb33165016483b046750a1451ae74a` |
| Log history | Monorepo Tauri | 1360x860 | `eafc6bd5d2a6d1f3e68b3b5e859a5b3d2bbb33165016483b046750a1451ae74a` |

## Evidence policy

Ordinary mode parses and validates evidence schema version 2 before comparison. It requires the exact six-state by three-source matrix; exact capture, mask, threshold, reference, dependency, managed fixture, and font identities; exact screenshot paths, hashes, dimensions, opacity, and nonblank content; and exact metric structures. Unknown schema fields and tampered screenshot SHA, capture config, or reference identity fail closed.

`UPDATE_VISUALS=1` captures all 18 PNGs and the JSON into a sibling staging directory. Every file is synced and closed, then the complete staged tree is validated before directory exchange. The current directory is renamed to a backup, staging becomes current, and failures restore the backup. Fault tests inject middle-PNG, JSON, and second-rename failures and require the old aggregate tree hash to remain byte-identical with no staging or backup residue.

If post-install directory sync and the first rollback rename both fail, cleanup preserves the only old baseline backup and the aggregated error reports its exact manual recovery path. Ordinary mode also requires committed box and pixel metrics to equal the fresh capture metrics exactly.

Once the installed evidence directory has been synced through its parent, the transaction is committed. A later partial backup-removal failure preserves the complete new current directory, leaves any partial old backup for inspection, and reports that backup path without entering rollback.

Visual operations retain a primary capture failure and a cleanup failure together in an `AggregateError`. Server, browser, temporary directory, managed fixture, font, and external reference cleanup phases are attempted even after earlier failures.

## Verification

- TDD support tests: 22 passed, including exact dependency fallback, optional platform closure handling, managed artifact equivalence, fixed-font routing, schema and metrics tampering, transactional rollback, post-commit cleanup, and failure aggregation.
- Managed-only update with a nonexistent `VISUAL_REFERENCE_ROOT`: passed and replaced the baseline transactionally.
- External reference mode: manifest verification, temporary `npm ci --ignore-scripts`, fresh build, managed artifact equivalence, and visual capture passed.
- `npm run test:visual`: two final ordinary managed-only runs passed consecutively without changing evidence.
- `npm test`: 479 passed, 0 failed.
- `npm run test:components`: 6 files and 50 tests passed.
- `npm run test:e2e`: 2 passed, 0 failed.
- `npm run lint`: passed with generated managed artifacts explicitly excluded from source linting.
- `npm run build:renderers`: Electron and Tauri renderers built; only the pre-existing chunk-size advisory was emitted.
- `bash scripts/verify-reference-integrity.sh <electron-reference> <tauri-reference>`: passed.
- `git diff --check`: passed.
- Process and temporary-resource audit: no visual/preview/Playwright process, evidence staging/backup directory, or visual temporary directory remained.
