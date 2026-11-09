import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readJson(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), 'utf8'));
}

test('Electron declares mqtt-contract as a direct renderer dependency', async () => {
  const manifest = await readJson('../package.json');

  assert.equal(manifest.dependencies['@ineed-mqtt-tool/mqtt-contract'], '*');
});

test('Electron workspace dependencies stay synchronized in the package lock', async () => {
  const [manifest, lockfile] = await Promise.all([
    readJson('../package.json'),
    readJson('../../../package-lock.json'),
  ]);

  assert.deepEqual(
    lockfile.packages['apps/electron'].dependencies,
    manifest.dependencies,
  );
  assert.equal(
    lockfile.packages['node_modules/@ineed-mqtt-tool/mqtt-contract'].resolved,
    'packages/mqtt-contract',
  );
  assert.equal(
    lockfile.packages['node_modules/@ineed-mqtt-tool/mqtt-contract'].link,
    true,
  );
});
