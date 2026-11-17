import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'espree';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const appRoots = ['apps/electron', 'apps/tauri'];
const rendererAllowlist = new Map([
  ['apps/electron', new Set(['main.js', 'runtimeAdapter.js'])],
  ['apps/tauri', new Set(['main.js', 'readinessReporter.js', 'runtimeAdapter.js'])],
]);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

async function listFiles(directory, excludedDirectories = new Set()) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter(entry => !entry.isDirectory() || !excludedDirectories.has(entry.name))
    .map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute, excludedDirectories) : [absolute];
    }));
  return nested.flat();
}

function importSource(node) {
  return node.type === 'ImportDeclaration' ? node.source.value : null;
}

function isMountCall(node) {
  return node?.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.property?.name === 'mount';
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

test('native renderer directories contain only thin bootstrap and adapter boundaries', async () => {
  for (const appRoot of appRoots) {
    const rendererRoot = path.join(repoRoot, appRoot, 'renderer');
    const files = await listFiles(rendererRoot);
    const relativeFiles = files.map(file => path.relative(rendererRoot, file));

    assert.deepEqual(
      relativeFiles.sort(),
      [...rendererAllowlist.get(appRoot)].sort(),
      `${appRoot}/renderer must not acquire shared UI files`,
    );
    assert.equal(relativeFiles.some(file => file.endsWith('.vue')), false);
    assert.equal(relativeFiles.some(file => file.endsWith('.css')), false);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.equal(source.includes('<template'), false, `${file} contains copied Vue markup`);
      assert.equal(source.includes('.mqtt-app'), false, `${file} contains copied workbench CSS`);
    }
  }
});

test('native source trees do not contain copied renderer components or workbench CSS', async () => {
  const nativeRoots = [
    path.join(repoRoot, 'apps/electron/electron'),
    path.join(repoRoot, 'apps/tauri/src-tauri'),
  ];

  for (const nativeRoot of nativeRoots) {
    // Cargo mutates target while native smoke tests run. Exclude it before traversal.
    const files = await listFiles(nativeRoot, new Set(['target']));
    assert.equal(files.some(file => file.endsWith('.vue')), false, `${nativeRoot} contains a Vue component`);
    assert.equal(files.some(file => file.endsWith('.css')), false, `${nativeRoot} contains renderer CSS`);
    for (const file of files.filter(file => /\.(?:cjs|js|rs|toml|json)$/.test(file))) {
      const source = await readFile(file, 'utf8');
      assert.equal(source.includes('.mqtt-app'), false, `${file} contains copied workbench styles`);
      assert.equal(source.includes('<template'), false, `${file} contains copied Vue markup`);
    }
  }
});

test('renderer entrypoints only compose runtime APIs with one shared workbench mount', async () => {
  for (const appRoot of appRoots) {
    const entryPath = path.join(repoRoot, appRoot, 'renderer/main.js');
    const source = await readFile(entryPath, 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const imports = ast.body.map(importSource).filter(Boolean);
    const workbenchImport = ast.body.find(node => (
      node.type === 'ImportDeclaration'
      && node.source.value === '@ineed-mqtt-tool/workbench'
    ));

    assert.ok(workbenchImport, `${entryPath} must import the shared workbench`);
    assert.deepEqual(
      workbenchImport.specifiers.map(specifier => specifier.imported?.name),
      ['createWorkbench'],
    );
    assert.ok(imports.includes('@ineed-mqtt-tool/workbench/base.css'));
    assert.equal(imports.some(specifier => specifier === 'vue' || specifier.endsWith('.vue')), false);
    assert.equal(imports.some(specifier => specifier.endsWith('.css') && specifier !== '@ineed-mqtt-tool/workbench/base.css'), false);

    const mountCalls = [];
    walk(ast, (node) => {
      if (isMountCall(node)) mountCalls.push(node);
    });
    assert.equal(mountCalls.length, 1, `${entryPath} must mount exactly once`);
    assert.equal(mountCalls[0].arguments[0]?.value, '#app');
  }
});

test('workbench is the only direct Vue owner and both apps depend on it', async () => {
  const workbenchPackage = await readJson('packages/workbench/package.json');
  assert.ok(workbenchPackage.dependencies?.vue, 'workbench must own Vue');
  assert.equal(workbenchPackage.exports?.['./base.css'], './src/styles/base.css');

  for (const appRoot of appRoots) {
    const appPackage = await readJson(`${appRoot}/package.json`);
    assert.equal(appPackage.dependencies?.['@ineed-mqtt-tool/workbench'], '*');
    assert.equal(appPackage.dependencies?.vue, undefined, `${appRoot} must not directly own Vue`);
  }
});
