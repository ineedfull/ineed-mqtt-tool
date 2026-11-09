# Phase 01 Verification

- Date: 2026-07-22
- Target branch: `codex/mqtt-monorepo-restructure`
- Target implementation HEAD: `bb1a56f129a4518c5d27a120a3a0a5b1ec0dc358`
- Gate verdict: **PASS**

## Scope Delivered

Phase 01 establishes the npm workspace foundation and shared, desktop-runtime-neutral contracts for MQTT data, runtime adapters, persistence/schema migration, domain behavior, and payload codecs. It also enforces shared-package import and lint boundaries.

This verification does not claim that either the Electron or Tauri application runs. Application integration and runtime verification remain later-phase work.

## Toolchain

All Node and npm checks used the Node 22 installation selected below:

```text
$ export PATH=/Users/pangzhigang/.nvm/versions/node/v22.22.0/bin:$PATH
$ node --version
v22.22.0
$ npm --version
10.9.4
```

`.nvmrc` selects Node 22, while `package.json` enforces `node >=22.13`; Node `v22.22.0` satisfies both.

## Repository Checks

```text
$ npm test
tests 79
suites 1
pass 79
fail 0
cancelled 0
skipped 0
todo 0
exit 0

$ npm run lint
> eslint .
exit 0

$ npm ci --dry-run --ignore-scripts --registry=https://registry.npmjs.org/
up to date in 177ms
18 packages are looking for funding
exit 0
```

The dry run validates the lockfile and npm install plan. It is not evidence that dependency install lifecycle scripts execute successfully.

A real clean dependency install was also run in a temporary local clone:

```text
$ npm ci --ignore-scripts --registry=https://registry.npmjs.org/
added 76 packages, and audited 82 packages in 4s
found 0 vulnerabilities
exit 0
```

Because that command intentionally used `--ignore-scripts`, it verifies dependency installation but not install lifecycle behavior.

## Package Artifact Checks

Each package was checked under Node `v22.22.0` and npm `10.9.4` with `npm pack --dry-run --json --workspace=<workspace>`. npm reports the artifact file count as `entryCount`.

| Workspace | Artifact files | Included paths | Result |
| --- | ---: | --- | --- |
| `@ineed-mqtt-tool/mqtt-contract` | 3 | `package.json`, `src/index.js`, `tests/mqttContract.test.js` | exit 0 |
| `@ineed-mqtt-tool/runtime-contract` | 3 | `package.json`, `src/index.js`, `tests/runtimeContract.test.js` | exit 0 |
| `@ineed-mqtt-tool/persistence-contract` | 4 | `package.json`, `src/schema.js`, `migrations/001-current-schema.sql`, `migrations/connection-pragmas.sql` | exit 0 |
| `@ineed-mqtt-tool/domain` | 7 | `package.json` and six files under `src/` | exit 0 |
| `@ineed-mqtt-tool/codecs` | 2 | `package.json`, `src/payloadCodec.js` | exit 0 |

Commands:

```text
npm pack --dry-run --json --workspace=@ineed-mqtt-tool/mqtt-contract
npm pack --dry-run --json --workspace=@ineed-mqtt-tool/runtime-contract
npm pack --dry-run --json --workspace=@ineed-mqtt-tool/persistence-contract
npm pack --dry-run --json --workspace=@ineed-mqtt-tool/domain
npm pack --dry-run --json --workspace=@ineed-mqtt-tool/codecs
```

## Reference Integrity

Before replacing the original workstation-specific SHA-1 evidence, both committed manifests were independently checked against their reference roots:

```text
$ shasum -c docs/verification/reference-manifests/electron.sha256
86 entries: OK
exit 0

$ shasum -c docs/verification/reference-manifests/tauri.sha256
144 entries: OK
exit 0
```

The durable manifests now contain true SHA-256 digests and paths relative to each reference root. `scripts/verify-reference-integrity.sh` changes into each root, prunes excluded directories, sorts relative file paths under `LC_ALL=C`, and runs `shasum -a 256`. Electron excludes `.git`, `node_modules`, `dist`, and `release`; Tauri excludes those directories plus `target`.

The committed manifests contain no absolute `/Users/` paths and require no `/tmp` baseline. Their checks are portable across machines when the two reference roots are supplied:

```bash
export ELECTRON_ROOT=/path/to/electron/ineed-mqtt-tool
export TAURI_ROOT=/path/to/tauri/ineed-mqtt-tool
scripts/verify-reference-integrity.sh "$ELECTRON_ROOT" "$TAURI_ROOT"
```

Normal mode regenerates temporary manifests, diffs them against the committed files, cleans up, and exits nonzero on drift or command failure. An intentional baseline refresh uses the same algorithm and atomically replaces each manifest:

```bash
scripts/verify-reference-integrity.sh --write "$ELECTRON_ROOT" "$TAURI_ROOT"
```

Manifest evidence:

| Reference | Entries | Manifest file SHA-256 | Portable format | Normal verification |
| --- | ---: | --- | --- | --- |
| Electron | 86 | `cda4c12e53f364e22fdbd35ff79cf82dd5204de00dff7ace2aa3a74618bfb357` | 64 hex + relative `./` path | no output, exit 0 |
| Tauri | 144 | `0c2ec8e6da48c8597efa297aa49c45db11b1ac530329ee2984e0ca74953fe4c8` | 64 hex + relative `./` path | no output, exit 0 |

The fixture test was written before the script. Its RED run failed with Bash exit 127 because the script was absent. After implementation:

```text
$ node --test scripts/verify-reference-integrity.test.mjs
tests 1
pass 1
fail 0
exit 0
```

The fixture covers write mode, relative 64-hex entries, directory exclusions, successful normal verification, mutation detection, and invalid-root rejection.

## History And Diff Checks

The following checks cover committed history since repository initialization, Phase 01 evidence commits, and the current worktree respectively:

```text
$ git log --check --oneline e1353f4..HEAD
no whitespace errors
exit 0

$ git diff --check bb1a56f..HEAD
no output
exit 0

$ git diff --check
no output
exit 0
```

The target implementation history through `bb1a56f` is:

```text
e1353f4 chore: initialize mqtt desk monorepo
156f097 chore: harden monorepo foundation
f9dc591 feat: define shared mqtt contract
923d471 fix: normalize mqtt status fields
a13922f fix: harden mqtt contract boundaries
596ab88 feat: define runtime adapter contract
62dbaac fix: harden runtime adapter validation
5c1bd57 feat: record mqtt persistence contract
a50c084 fix: separate sqlite connection and schema contracts
ddd267d fix: accept legacy sqlite default syntax
f2e2d7f refactor: extract mqtt domain and codecs
183462c test: enforce shared package boundaries
bb1a56f test: close shared package import gaps
```

## Final Gate

```text
$ npm test && npm run lint && git diff --check
tests 79; suites 1; pass 79; fail 0
eslint .
git diff --check produced no output
exit 0

$ scripts/verify-reference-integrity.sh "$ELECTRON_ROOT" "$TAURI_ROOT"
no output
exit 0
```

**PASS**: Phase 01's workspace and shared contracts pass all requested tests, lint, lockfile/install-plan, package artifact, whitespace, and reproducible reference-integrity checks. The Electron and Tauri source references match their portable SHA-256 manifests.
