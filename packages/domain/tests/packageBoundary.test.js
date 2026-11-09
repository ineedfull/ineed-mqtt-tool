import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import * as domain from '@ineed-mqtt-tool/domain';
import * as connectionModel from '@ineed-mqtt-tool/domain/connection-model';
import * as topicMatcher from '@ineed-mqtt-tool/domain/topic-matcher';
import * as subscriptionCoverage from '@ineed-mqtt-tool/domain/subscription-coverage';
import * as subscriptionRouting from '@ineed-mqtt-tool/domain/subscription-routing';
import * as connectionDiagnostics from '@ineed-mqtt-tool/domain/connection-diagnostics';

import * as messageScenario from '../src/messageScenario.js';

const sourceDirectory = new URL('../src/', import.meta.url);

async function findJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? findJavaScriptFiles(url) : [url];
  }));

  return nestedFiles.flat().filter(url => url.pathname.endsWith('.js'));
}

test('package root re-exports every domain module export', () => {
  const moduleExports = Object.assign(
    {},
    connectionModel,
    topicMatcher,
    subscriptionCoverage,
    subscriptionRouting,
    connectionDiagnostics,
    messageScenario,
  );

  assert.deepEqual(Object.keys(domain).sort(), Object.keys(moduleExports).sort());
  for (const [name, value] of Object.entries(moduleExports)) {
    assert.equal(domain[name], value, name);
  }
});

test('package manifest publishes only domain source files', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.deepEqual(manifest.files, ['src/']);
});

test('domain source stays independent of desktop runtimes and UI frameworks', async () => {
  const forbidden = /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:electron(?:\/|['"])|@tauri-apps\/|vue(?:\/|['"]))|\b(?:window|document|navigator|localStorage|sessionStorage)\b/;

  for (const file of await findJavaScriptFiles(sourceDirectory)) {
    assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, file.pathname);
  }
});
