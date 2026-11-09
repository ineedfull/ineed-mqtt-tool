/* global document, getComputedStyle, window */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { installBrowserFixture } from './fixtures/previewAdapter.js';
import {
  assertVisualMetricsMatch,
  computeVisualConfigHash,
  replaceVisualEvidenceTransactionally,
  runWithVisualCleanup,
  startVisualRendererServers,
  validateVisualEvidence,
} from './support/captureReference.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const screenshotRoot = path.join(repoRoot, 'docs/verification/screenshots');
const updateVisuals = process.env.UPDATE_VISUALS === '1';
const viewport = { width: 1360, height: 860 };
const pixelThreshold = 0.1;
const referenceDiffLimit = 0.005;

const states = [
  {
    id: 'main-messages',
    route: '',
    ready: async page => expect(page.locator('.chat-msg')).toHaveCount(3),
    selectors: ['.mqtt-app', '.left-panel', '.main-area', '.status-bar', '.sub-panel', '.msg-toolbar', '.msg-chat', '.publish-bar'],
    layoutPair: ['.left-panel', '.main-area'],
  },
  {
    id: 'logs',
    route: '',
    ready: async (page) => {
      await expect(page.locator('.chat-msg')).toHaveCount(3);
      await page.getByRole('button', { exact: true, name: '日志' }).click();
      await expect(page.locator('.log-line')).toHaveCount(3);
    },
    selectors: ['.mqtt-app', '.left-panel', '.main-area', '.status-bar', '.log-view', '.log-view .msg-toolbar', '.msg-terminal', '.publish-bar'],
    layoutPair: ['.left-panel', '.main-area'],
  },
  {
    id: 'connection-dialog',
    route: '',
    ready: async (page) => {
      await expect(page.locator('.chat-msg')).toHaveCount(3);
      await page.getByTitle('新建连接').click();
      await expect(page.locator('.modal')).toBeVisible();
      await expect(page.getByRole('heading', { name: '新建连接' })).toBeVisible();
    },
    selectors: ['.mqtt-app', '.left-panel', '.main-area', '.modal-overlay', '.modal', '.modal__header', '.modal__body', '.modal__footer'],
    layoutPair: ['.left-panel', '.main-area'],
  },
  {
    id: 'settings',
    route: '',
    ready: async (page) => {
      await expect(page.locator('.chat-msg')).toHaveCount(3);
      await page.getByText('设置', { exact: true }).click();
      await expect(page.getByText('数据存储', { exact: true })).toBeVisible();
      await expect(page.getByText('12 KB', { exact: true })).toBeVisible();
    },
    selectors: ['.mqtt-app', '.left-panel', '.main-area', '.status-bar', '.settings-area', '.settings-group', '.storage-stats'],
    layoutPair: ['.left-panel', '.main-area'],
  },
  {
    id: 'message-history',
    route: 'history=messages',
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: '历史消息' })).toBeVisible();
      await expect(page.locator('.history-row')).toHaveCount(3);
    },
    selectors: ['.history-page', '.history-header', '.history-filters', '.history-body', '.history-list', '.history-detail', '.history-pager'],
    layoutPair: ['.history-list', '.history-detail'],
  },
  {
    id: 'log-history',
    route: 'history=logs',
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: '历史日志' })).toBeVisible();
      await expect(page.locator('.history-row')).toHaveCount(3);
    },
    selectors: ['.history-page', '.history-header', '.history-filters', '.history-body', '.history-list', '.history-detail', '.history-pager'],
    layoutPair: ['.history-list', '.history-detail'],
  },
];

function evidencePath(stateId, sourceId) {
  return path.join(screenshotRoot, evidenceRelativePath(stateId, sourceId));
}

function evidenceRelativePath(stateId, sourceId) {
  return stateId === 'main-messages' ? `${sourceId}.png` : `${stateId}/${sourceId}.png`;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function visualContract(servers) {
  return {
    capture: {
      colorScheme: 'light',
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      viewport,
    },
    fonts: {
      assets: servers.fonts.metadata.assets,
      license: servers.fonts.metadata.license,
      metadataSha256: servers.fonts.metadataSha256,
      monoFamily: servers.fonts.metadata.fonts.mono.family,
      sources: servers.fonts.metadata.sources,
      uiFamily: servers.fonts.metadata.fonts.ui.family,
    },
    masks: [],
    reference: {
      dependencyClosureSha256: servers.managedFixture.metadata.dependencies.closureSha256,
      dependencyLockSha256: servers.managedFixture.metadata.dependencies.lockSha256,
      dependencyPackageCount: servers.managedFixture.metadata.dependencies.packageCount,
      entryCount: servers.referenceManifest.entryCount,
      managedFixtureMetadataSha256: servers.managedFixture.metadataSha256,
      manifest: 'docs/verification/reference-manifests/electron.sha256',
      manifestSha256: servers.referenceManifest.manifestSha256,
      source: 'packages/workbench/e2e/fixtures/reference-renderer',
    },
    sources: servers.sources.map(source => source.id),
    states: states.map(state => state.id),
    threshold: {
      boundingBoxMaxDeltaPx: 2,
      electronTauriDiffPixels: 0,
      pixelmatch: pixelThreshold,
      referenceDiffPercentMax: referenceDiffLimit * 100,
    },
  };
}

function readPng(contents) {
  const png = PNG.sync.read(contents);
  assert.equal(png.width, viewport.width, 'screenshot width must be 1360');
  assert.equal(png.height, viewport.height, 'screenshot height must be 860');
  return png;
}

function analyzePng(contents) {
  const png = readPng(contents);
  const samples = new Set();
  let nontransparentPixels = 0;
  let nonbackgroundSamples = 0;
  const first = `${png.data[0]},${png.data[1]},${png.data[2]},${png.data[3]}`;

  for (let y = 0; y < png.height; y += 20) {
    for (let x = 0; x < png.width; x += 20) {
      const offset = (y * png.width + x) * 4;
      const sample = `${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]},${png.data[offset + 3]}`;
      samples.add(sample);
      if (sample !== first) nonbackgroundSamples += 1;
    }
  }
  for (let offset = 3; offset < png.data.length; offset += 4) {
    if (png.data[offset] !== 0) nontransparentPixels += 1;
  }

  assert.equal(nontransparentPixels, png.width * png.height, 'screenshot must not contain transparent pixels');
  assert.ok(samples.size >= 16, `screenshot is blank or nearly blank (${samples.size} sampled colors)`);
  assert.ok(nonbackgroundSamples >= 50, `screenshot has too little rendered content (${nonbackgroundSamples} samples)`);
  return { height: png.height, nonbackgroundSamples, sampledColors: samples.size, width: png.width };
}

function comparePng(expectedContents, actualContents) {
  const expected = readPng(expectedContents);
  const actual = readPng(actualContents);
  const diff = new PNG({ height: viewport.height, width: viewport.width });
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    viewport.width,
    viewport.height,
    { threshold: pixelThreshold },
  );
  return {
    diffBuffer: diffPixels > 0 ? PNG.sync.write(diff) : null,
    diffPercent: diffPixels / (viewport.width * viewport.height),
    diffPixels,
  };
}

function maxBoxDelta(referenceBoxes, targetBoxes) {
  assert.deepEqual(Object.keys(targetBoxes), Object.keys(referenceBoxes));
  let maximum = 0;
  for (const key of Object.keys(referenceBoxes)) {
    for (const dimension of ['x', 'y', 'width', 'height']) {
      maximum = Math.max(maximum, Math.abs(referenceBoxes[key][dimension] - targetBoxes[key][dimension]));
    }
  }
  return maximum;
}

async function captureBoxes(page, selectors) {
  return page.evaluate((stableSelectors) => {
    const boxes = {};
    for (const selector of stableSelectors) {
      const elements = [...document.querySelectorAll(selector)].filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (elements.length === 0) throw new Error(`stable selector is missing: ${selector}`);
      elements.forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        boxes[`${selector}[${index}]`] = {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      });
    }
    return boxes;
  }, selectors);
}

async function assertLayout(page, state) {
  const result = await page.evaluate(({ layoutPair }) => {
    const visible = element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const overflow = {
      bodyHeight: document.body.scrollHeight,
      bodyWidth: document.body.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
    const textOverflow = [...document.querySelectorAll('button, select')]
      .filter(visible)
      .filter(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      .map(element => ({
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        text: element.textContent?.trim(),
      }));
    const first = document.querySelector(layoutPair[0])?.getBoundingClientRect();
    const second = document.querySelector(layoutPair[1])?.getBoundingClientRect();
    return {
      overlap: first && second ? Math.max(0, first.right - second.left) : null,
      overflow,
      textOverflow,
    };
  }, { layoutPair: state.layoutPair });

  assert.ok(result.overflow.documentWidth <= viewport.width, `document overflows viewport width: ${JSON.stringify(result.overflow)}`);
  assert.ok(result.overflow.documentHeight <= viewport.height, `document overflows viewport height: ${JSON.stringify(result.overflow)}`);
  assert.equal(result.overlap, 0, `${state.layoutPair.join(' and ')} overlap`);
  assert.deepEqual(result.textOverflow, [], `button/select text does not fit: ${JSON.stringify(result.textOverflow)}`);
  return result.overflow;
}

async function assertManagedFonts(page, fonts, { requireMonoDom }) {
  const result = await page.evaluate(async ({ monoFamily, uiFamily }) => {
    await Promise.all([
      document.fonts.load(`400 16px "${uiFamily}"`, '设置历史日志连接消息'),
      document.fonts.load(`400 16px "${monoFamily}"`, 'MQTT 0123456789'),
    ]);
    await document.fonts.ready;
    const family = element => getComputedStyle(element).fontFamily;
    const uiElements = [...document.querySelectorAll('body, button, input, select, textarea')];
    const monoElements = [...document.querySelectorAll('code, pre, .cm-editor, .cm-editor *')];
    const monoSentinel = document.createElement('span');
    monoSentinel.style.cssText = `position:fixed;visibility:hidden;font-family:"${monoFamily}"`;
    monoSentinel.textContent = 'MQTT 0123456789';
    document.body.append(monoSentinel);
    const monoSentinelFamily = family(monoSentinel);
    monoSentinel.remove();
    return {
      checks: {
        mono: document.fonts.check(`400 16px "${monoFamily}"`, 'MQTT 0123456789'),
        ui: document.fonts.check(`400 16px "${uiFamily}"`, '设置历史日志连接消息'),
      },
      monoFamilies: [...new Set(monoElements.map(family))],
      monoNodeCount: monoElements.length,
      monoSentinelFamily,
      uiFamilies: [...new Set(uiElements.map(family))],
      uiNodeCount: uiElements.length,
    };
  }, fonts);
  assert.deepEqual(result.checks, { mono: true, ui: true }, 'managed visual fonts did not load');
  assert.ok(result.uiNodeCount > 0, 'no UI text nodes were available for font verification');
  assert.deepEqual(result.uiFamilies, [`"${fonts.uiFamily}"`], 'UI DOM font family differs');
  assert.equal(result.monoSentinelFamily, `"${fonts.monoFamily}"`, 'managed monospace sentinel family differs');
  if (requireMonoDom) assert.ok(result.monoNodeCount > 0, 'target CodeMirror DOM was not available for font verification');
  if (result.monoNodeCount > 0) {
    assert.deepEqual(result.monoFamilies, [`"${fonts.monoFamily}"`], 'monospace DOM font family differs');
  }
  return result;
}

async function captureState(page, source, state, fonts) {
  const errors = [];
  const onPageError = error => errors.push(`pageerror: ${error.message}`);
  const onConsole = (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  try {
    const query = [state.route, `visualRuntime=${source.runtime}`].filter(Boolean).join('&');
    await page.goto(`${source.url}?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await state.ready(page);
    const fontResult = await assertManagedFonts(page, fonts, {
      requireMonoDom: source.runtime !== 'reference' && state.id === 'main-messages',
    });
    await page.evaluate(() => {
      document.documentElement.dataset.visualReady = 'true';
    });
    await expect(page.locator('html')).toHaveAttribute('data-visual-ready', 'true');
    const boxes = await captureBoxes(page, state.selectors);
    const overflow = await assertLayout(page, state);
    const screenshot = await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: false });
    const image = analyzePng(screenshot);
    assert.deepEqual(errors, [], `${source.id}/${state.id} emitted browser errors`);
    return { boxes, errors, fonts: fontResult, image, overflow, screenshot };
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
  }
}

test('current Electron, monorepo Electron, and monorepo Tauri have six-state visual parity', async ({ browser, page }, testInfo) => {
  const servers = await startVisualRendererServers({ repoRoot });
  const contract = visualContract(servers);
  const captures = new Map();
  const metrics = {};

  return runWithVisualCleanup(async () => {
    const committedEvidence = updateVisuals
      ? null
      : await validateVisualEvidence({ contract, evidenceRoot: screenshotRoot });
    await page.route('**/favicon.ico', route => route.fulfill({ body: '', contentType: 'image/x-icon', status: 200 }));
    await page.addInitScript(installBrowserFixture);

    for (const state of states) {
      const stateCaptures = {};
      for (const source of servers.sources) {
        stateCaptures[source.id] = await captureState(page, source, state, contract.fonts);
        await writeFile(
          testInfo.outputPath(`${state.id}-${source.id}.png`),
          stateCaptures[source.id].screenshot,
        );
        captures.set(`${state.id}/${source.id}`, stateCaptures[source.id]);
      }

      const reference = stateCaptures['current-electron'];
      const electron = stateCaptures['monorepo-electron'];
      const tauri = stateCaptures['monorepo-tauri'];
      const referenceElectron = comparePng(reference.screenshot, electron.screenshot);
      const referenceTauri = comparePng(reference.screenshot, tauri.screenshot);
      const electronTauri = comparePng(electron.screenshot, tauri.screenshot);
      const electronBoxDelta = maxBoxDelta(reference.boxes, electron.boxes);
      const tauriBoxDelta = maxBoxDelta(reference.boxes, tauri.boxes);
      const runtimeBoxDelta = maxBoxDelta(electron.boxes, tauri.boxes);

      if (referenceElectron.diffBuffer) await writeFile(testInfo.outputPath(`${state.id}-reference-electron-diff.png`), referenceElectron.diffBuffer);
      if (referenceTauri.diffBuffer) await writeFile(testInfo.outputPath(`${state.id}-reference-tauri-diff.png`), referenceTauri.diffBuffer);
      if (electronTauri.diffBuffer) await writeFile(testInfo.outputPath(`${state.id}-electron-tauri-diff.png`), electronTauri.diffBuffer);

      assert.ok(referenceElectron.diffPercent <= referenceDiffLimit, `${state.id} Electron differs from reference by ${(referenceElectron.diffPercent * 100).toFixed(4)}%`);
      assert.ok(referenceTauri.diffPercent <= referenceDiffLimit, `${state.id} Tauri differs from reference by ${(referenceTauri.diffPercent * 100).toFixed(4)}%`);
      assert.equal(electronTauri.diffPixels, 0, `${state.id} Electron and Tauri must be pixel-identical`);
      assert.ok(electronBoxDelta <= 2, `${state.id} Electron box delta is ${electronBoxDelta}px`);
      assert.ok(tauriBoxDelta <= 2, `${state.id} Tauri box delta is ${tauriBoxDelta}px`);
      assert.equal(runtimeBoxDelta, 0, `${state.id} Electron/Tauri box delta is ${runtimeBoxDelta}px`);

      metrics[state.id] = {
        boxes: {
          electronTauriMaxDeltaPx: runtimeBoxDelta,
          referenceElectronMaxDeltaPx: electronBoxDelta,
          referenceTauriMaxDeltaPx: tauriBoxDelta,
        },
        pixels: {
          electronTauri,
          referenceElectron,
          referenceTauri,
        },
      };
      for (const comparison of Object.values(metrics[state.id].pixels)) delete comparison.diffBuffer;
    }

    if (!updateVisuals) {
      assertVisualMetricsMatch(committedEvidence.metrics, metrics);
      for (const state of states) {
        for (const source of servers.sources) {
          const baselinePath = evidencePath(state.id, source.id);
          const baseline = await readFile(baselinePath);
          const comparison = comparePng(baseline, captures.get(`${state.id}/${source.id}`).screenshot);
          assert.ok(comparison.diffPercent <= referenceDiffLimit, `${state.id}/${source.id} differs from committed evidence by ${(comparison.diffPercent * 100).toFixed(4)}%`);
        }
      }
    } else {
      const screenshotRecords = {};
      const screenshots = new Map();
      for (const state of states) {
        screenshotRecords[state.id] = {};
        for (const source of servers.sources) {
          const capture = captures.get(`${state.id}/${source.id}`);
          const relativePath = evidenceRelativePath(state.id, source.id);
          screenshots.set(relativePath, capture.screenshot);
          screenshotRecords[state.id][source.id] = {
            height: capture.image.height,
            path: relativePath,
            sha256: sha256(capture.screenshot),
            width: capture.image.width,
          };
        }
      }

      const evidence = {
        version: 2,
        browser: {
          name: 'chromium',
          platform: process.platform,
          version: browser.version(),
        },
        ...contract,
        configSha256: computeVisualConfigHash(contract),
        metrics,
        screenshots: screenshotRecords,
      };
      await replaceVisualEvidenceTransactionally({
        evidence,
        screenshotRoot,
        screenshots,
        validateStaging: evidenceRoot => validateVisualEvidence({ contract, evidenceRoot }),
      });
    }

    await writeFile(testInfo.outputPath('visual-parity-run.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  }, () => servers.close());
});
