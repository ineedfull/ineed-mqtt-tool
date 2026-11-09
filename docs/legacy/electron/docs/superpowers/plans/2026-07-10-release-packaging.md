# Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce timestamped ZIP-only Electron release output for macOS, Windows, and Linux while automatically removing stale and intermediate artifacts.

**Architecture:** A dependency-free Node module owns release cleanup, timestamp formatting, artifact finalization, and the full Electron Builder command sequence. Filesystem behavior is tested against temporary directories; the package script exposes the workflow through `npm run dist`.

**Tech Stack:** Node.js ESM, `node:test`, Electron Builder, host `zip` utility, npm scripts.

---

### Task 1: Specify release cleanup and finalization behavior

**Files:**
- Create: `tests/releasePackaging.test.js`
- Create: `scripts/release-packaging.mjs`

- [ ] **Step 1: Write failing tests**

Add tests that import `cleanRelease`, `finalizeRelease`, and `formatBuildTime`. Verify cleanup recreates an empty directory and finalization leaves exactly five timestamped ZIP files after receiving two macOS ZIPs, two Windows executables, one Linux AppImage, Builder YAML files, and unpacked directories.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/releasePackaging.test.js`

Expected: FAIL because `scripts/release-packaging.mjs` does not exist.

- [ ] **Step 3: Implement the minimal filesystem API**

Export these functions from `scripts/release-packaging.mjs`:

```js
export function formatBuildTime(date = new Date()) {}
export function cleanRelease(releaseDir) {}
export function finalizeRelease({ releaseDir, version, buildTime, archiveFile }) {}
```

`finalizeRelease` must validate all five source artifacts before cleanup, wrap `.exe` and `.AppImage` files through the injected/default archiver, rename macOS ZIPs, and remove every non-final entry.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/releasePackaging.test.js`

Expected: all release packaging tests pass.

### Task 2: Orchestrate the multi-platform green build

**Files:**
- Modify: `scripts/release-packaging.mjs`
- Modify: `package.json`
- Test: `tests/releasePackaging.test.js`

- [ ] **Step 1: Add a failing package-script contract test**

Read `package.json` and assert that `dist` calls `node scripts/release-packaging.mjs build`, while regular `build` remains `vite build`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/releasePackaging.test.js`

Expected: FAIL because `dist` still directly invokes Electron Builder.

- [ ] **Step 3: Add the build command**

Implement a `build` CLI command that performs this sequence and stops on the first failure:

```text
clean release
npm run build
electron-builder --mac zip --x64 --arm64
electron-builder --win portable --x64
electron-builder --win portable --ia32
electron-builder --linux AppImage --x64
finalize release with one shared timestamp
```

Pass explicit `${version}`, `${arch}`, and `${ext}` artifact templates as argument-array values so shell interpolation cannot alter them. Use the Electron Builder binary from `node_modules/.bin`.

- [ ] **Step 4: Update package scripts and verify GREEN**

Set `dist` to `node scripts/release-packaging.mjs build`. Keep `npm run build` unchanged.

Run: `node --test tests/releasePackaging.test.js`

Expected: all release packaging tests pass.

### Task 3: Verify and produce the release

**Files:**
- Generated: `release/*.zip`

- [ ] **Step 1: Run all automated checks**

Run: `npm test`

Expected: zero failures.

Run: `npm run lint -- --quiet`

Expected: exit code 0.

- [ ] **Step 2: Build all green packages**

Run: `npm run dist`

Expected: macOS x64/arm64, Windows x64/ia32, and Linux x64 build successfully.

- [ ] **Step 3: Verify final directory contract**

Verify `release` contains exactly five `.zip` files, all names share one `yyyyMMdd-HHmmss` timestamp, no directories remain, and each ZIP passes `unzip -t`.
