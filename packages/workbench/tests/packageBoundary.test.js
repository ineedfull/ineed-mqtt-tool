import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import test from 'node:test';

const expectedPortedModules = [
  'batchedPersistence.js',
  'historyPayload.js',
  'historyTime.js',
  'logLevel.js',
  'messageFilters.js',
  'payloadEditorState.js',
  'realtimeItems.js',
  'settingsModel.js',
  'storageStats.js',
  'timeFormat.js',
];
const transitionalBridge = 'topicMatcher.js';
const sourceDirectory = new URL('../src/', import.meta.url);
const workspaceDirectory = new URL('workspace/', sourceDirectory);
const expectedUiFiles = [
  'App.vue',
  'createWorkbench.js',
  'layouts/HistoryWindow.vue',
  'layouts/MqttToolShell.vue',
  'layouts/PayloadEditor.vue',
  'styles/base.css',
  'workspace/clipboard.js',
  'workspace/publishWorkflow.js',
  'workspace/withTimeout.js',
];
const builtinRoots = new Set(builtinModules.map(moduleName => (
  moduleName.replace(/^node:/, '').split('/')[0]
)));

function isDesktopRuntimeImport(specifier) {
  const root = specifier.split('/')[0];
  return specifier.startsWith('node:')
    || builtinRoots.has(root)
    || specifier === 'electron'
    || specifier.startsWith('electron/')
    || specifier.startsWith('@tauri-apps/');
}

async function discoverWorkspaceModules() {
  const entries = await readdir(workspaceDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name)
    .sort();
}

async function discoverSharedSources(directory = sourceDirectory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      discovered.push(...await discoverSharedSources(
        new URL(`${entry.name}/`, directory),
        `${relativePath}/`,
      ));
    } else if (/\.(?:css|js|vue)$/.test(entry.name)) {
      discovered.push(relativePath);
    }
  }

  return discovered.sort();
}

function assertRequiredWorkspaceModules(modules) {
  const discovered = new Set(modules);
  for (const moduleName of [...expectedPortedModules, transitionalBridge]) {
    assert.equal(discovered.has(moduleName), true, moduleName);
  }
}

test('workbench package exposes the planned public metadata', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(manifest.name, '@ineed-mqtt-tool/workbench');
  const rootManifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, rootManifest.version);
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.files, ['src/']);
  assert.deepEqual(manifest.exports, {
    '.': './src/createWorkbench.js',
    './base.css': './src/styles/base.css',
    './runtimeContext.js': './src/runtimeContext.js',
  });
  assert.deepEqual(manifest.scripts, {
    test: 'node --test tests/*.test.js',
    'test:components': 'vitest run --config vitest.config.js',
    'test:e2e': 'playwright test --config playwright.config.js',
    'test:visual': 'playwright test --config playwright.visual.config.js',
  });
  assert.deepEqual(manifest.dependencies, {
    '@lezer/highlight': '^1.2.3',
    'lucide-vue-next': '^0.468.0',
    '@codemirror/commands': '6.10.4',
    '@codemirror/lang-json': '6.0.2',
    '@codemirror/language': '6.12.4',
    '@codemirror/lint': '6.9.7',
    '@codemirror/search': '6.7.1',
    '@codemirror/state': '6.7.1',
    '@codemirror/view': '6.43.6',
    '@ineed-mqtt-tool/codecs': '*',
    '@ineed-mqtt-tool/domain': '*',
    '@ineed-mqtt-tool/mqtt-contract': '*',
    '@ineed-mqtt-tool/persistence-contract': '*',
    '@ineed-mqtt-tool/runtime-contract': '*',
    vue: '^3.5.32',
  });
  assert.deepEqual(manifest.devDependencies, {
    '@playwright/test': '^1.55.0',
    '@vitejs/plugin-vue': '^6.0.6',
    '@vue/compiler-sfc': '^3.5.32',
    '@vue/test-utils': '^2.4.6',
    jsdom: '^26.1.0',
    pixelmatch: '^7.2.0',
    pngjs: '^7.0.0',
    vitest: '^4.1.10',
  });
});

test('workbench package includes the ten ported helpers and explicit transitional bridge', async () => {
  assertRequiredWorkspaceModules(await discoverWorkspaceModules());
});

test('future runtime-neutral workspace helpers do not violate the required module set', () => {
  assert.doesNotThrow(() => assertRequiredWorkspaceModules([
    ...expectedPortedModules,
    transitionalBridge,
    'runtimeFacade.js',
  ]));
});

test('shared workbench contains the expected Vue UI surface', async () => {
  const discovered = new Set(await discoverSharedSources());

  for (const relativePath of expectedUiFiles) {
    assert.equal(discovered.has(relativePath), true, relativePath);
  }
});

test('shared workbench sources stay independent of desktop runtimes', async () => {
  const importPattern = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const forbiddenGlobals = /\b(?:window\.ineedMqtt|window\.__TAURI__|electronClipboard)\b/;

  for (const relativePath of await discoverSharedSources()) {
    const source = await readFile(new URL(relativePath, sourceDirectory), 'utf8');
    const forbiddenImports = [...source.matchAll(importPattern)]
      .map(match => match[1])
      .filter(isDesktopRuntimeImport);
    assert.deepEqual(forbiddenImports, [], relativePath);
    assert.doesNotMatch(source, forbiddenGlobals, relativePath);
  }
});

test('transitional topic bridge prevents duplicate topic-matching ownership', async () => {
  const source = await readFile(new URL(transitionalBridge, workspaceDirectory), 'utf8');

  assert.equal(source, "export { matchesTopic } from '@ineed-mqtt-tool/domain/topic-matcher';\n");
});

test('every declared export and script target exists or is runnable', async () => {
  const packageDirectory = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', packageDirectory), 'utf8'));

  for (const [exportPath, target] of Object.entries(manifest.exports ?? {})) {
    await access(new URL(target, packageDirectory));
    if (exportPath === './runtimeContext.js') {
      const subpath = exportPath === '.' ? '' : exportPath.slice(1);
      await import(`${manifest.name}${subpath}`);
    }
  }

  for (const script of Object.values(manifest.scripts ?? {})) {
    const [command] = script.trim().split(/\s+/);
    const executable = command === 'node'
      ? process.execPath
      : new URL(`../../../node_modules/.bin/${command}`, import.meta.url);
    await access(executable, constants.X_OK);

    for (const match of script.matchAll(/(?:--config|-c)\s+(\S+)/g)) {
      await access(new URL(match[1], packageDirectory));
    }
  }
});

test('the Phase 02 deferred UI contract names remain executable in the workbench', async () => {
  const source = await readFile(new URL('./uiContract.test.js', import.meta.url), 'utf8');
  const expectedNames = [
    'message classification does not mutate subscription lifecycle status',
    'stored legacy and duplicate colors are reassigned during loading',
    'status bar uses connection session counters instead of retained realtime row counts',
  ];

  for (const name of expectedNames) {
    assert.equal(source.includes(`test('${name}'`), true, name);
  }
});
