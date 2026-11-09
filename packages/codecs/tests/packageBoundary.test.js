import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ESLint } from 'eslint';

import * as codecs from '@ineed-mqtt-tool/codecs';
import * as payloadCodec from '@ineed-mqtt-tool/codecs/payload-codec';

const sourceDirectory = new URL('../src/', import.meta.url);
const rootDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: rootDirectory });
const sharedSourcePaths = [
  fileURLToPath(new URL('../../domain/src/topicMatcher.js', import.meta.url)),
  fileURLToPath(new URL('../src/payloadCodec.js', import.meta.url)),
];

async function findJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? findJavaScriptFiles(url) : [url];
  }));

  return nestedFiles.flat().filter(url => url.pathname.endsWith('.js'));
}

test('package root exports every payload codec function', () => {
  assert.deepEqual(Object.keys(codecs).sort(), Object.keys(payloadCodec).sort());
  for (const [name, value] of Object.entries(payloadCodec)) {
    assert.equal(codecs[name], value, name);
  }
});

test('package manifest publishes only codec source files', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.deepEqual(manifest.files, ['src/']);
});

test('codec source stays independent of desktop runtimes and UI frameworks', async () => {
  const forbidden = /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:electron(?:\/|['"])|@tauri-apps\/|vue(?:\/|['"]))|\b(?:window|document|navigator|localStorage|sessionStorage)\b/;

  for (const file of await findJavaScriptFiles(sourceDirectory)) {
    assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, file.pathname);
  }
});

async function lintSharedProbe(source) {
  return Promise.all(sharedSourcePaths.map(async filePath => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages;
  }));
}

test('shared sources reject static node:sqlite imports', async () => {
  for (const messages of await lintSharedProbe("import sqlite from 'node:sqlite';\nvoid sqlite;")) {
    assert.deepEqual(messages.map(message => message.ruleId), ['no-restricted-imports']);
  }
});

test('shared sources reject static node:test/reporters imports', async () => {
  for (const messages of await lintSharedProbe("import reporters from 'node:test/reporters';\nvoid reporters;")) {
    assert.deepEqual(messages.map(message => message.ruleId), ['no-restricted-imports']);
  }
});

test('shared sources reject dynamic imports', async () => {
  for (const messages of await lintSharedProbe("await import('node:fs');")) {
    assert.deepEqual(messages.map(message => message.ruleId), ['no-restricted-syntax']);
  }
});

test('shared sources allow normal relative static imports', async () => {
  for (const messages of await lintSharedProbe("import './relative-module.js';")) {
    assert.deepEqual(messages, []);
  }
});

test('existing shared package sources lint clean', async () => {
  const results = await eslint.lintFiles([
    'packages/domain/src/**/*.js',
    'packages/codecs/src/**/*.js',
  ]);

  assert.equal(results.reduce((count, result) => count + result.errorCount, 0), 0);
});

test('lint config enforces shared package runtime boundaries', async () => {
  const codecConfig = await eslint.calculateConfigForFile(fileURLToPath(
    new URL('../src/payloadCodec.js', import.meta.url),
  ));
  const domainConfig = await eslint.calculateConfigForFile(fileURLToPath(
    new URL('../../domain/src/topicMatcher.js', import.meta.url),
  ));

  assert.equal(codecConfig.languageOptions.globals?.TextEncoder, 'readonly');
  assert.equal(codecConfig.languageOptions.globals?.TextDecoder, 'readonly');
  for (const globalName of ['window', 'document', 'navigator', 'process', 'require', 'TextEncoder', 'TextDecoder']) {
    assert.equal(domainConfig.languageOptions.globals?.[globalName], undefined, globalName);
  }

  for (const config of [codecConfig, domainConfig]) {
    const rule = config.rules['no-restricted-imports'];
    assert.ok(rule, 'no-restricted-imports must be configured');
    const [severity, options] = rule;
    const restrictedPaths = new Set((options?.paths ?? []).map(path => (
      typeof path === 'string' ? path : path.name
    )));
    const restrictedPatterns = (options?.patterns ?? []).flatMap(pattern => (
      typeof pattern === 'string' ? [pattern] : pattern.group ?? []
    ));

    assert.equal(severity, 2);
    assert.equal(restrictedPaths.has('fs'), true);
    assert.equal(restrictedPaths.has('path'), true);
    assert.equal(restrictedPatterns.includes('node:*'), true);
  }
});
