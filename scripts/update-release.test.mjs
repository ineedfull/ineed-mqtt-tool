import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planUpdates, writeUpdateCollection, verifyUpdateCollection, uploadUpdates, requireSigning, validateMacIdentity, validateWindowsIdentity } from './update-release.mjs';

async function collection(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mqtt-update-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const publicKeys = { electron: keys.publicKey.export({ format: 'pem', type: 'spki' }) };
  const privateKeys = { electron: keys.privateKey };
  const bytes = Buffer.alloc(128); bytes.write('PK\x03\x04');
  await writeFile(path.join(directory, 'mqtt.zip'), bytes);
  const dmg = Buffer.alloc(1024); dmg.write('koly', 512);
  await writeFile(path.join(directory, 'mqtt.dmg'), dmg);
  await writeUpdateCollection(directory, { version: '0.1.1', buildId: 'isolated-test', publicKeys,
    manualInstallers: [{ runtime: 'electron', platform: 'macos', arch: 'arm64', format: 'dmg', name: 'mqtt.dmg' }],
    artifacts: [{ runtime: 'electron', platform: 'macos', arch: 'arm64', format: 'zip', name: 'mqtt.zip' }] }, privateKeys);
  return { directory, publicKeys };
}

test('update plans include dedicated mac archives and omit automatic deb installation', () => {
  assert.deepEqual(planUpdates({ platform: 'macos', arch: 'arm64' }).map(job => [job.runtime, job.updateFormat]),
    [['electron', 'zip'], ['tauri', 'app-tar-gz']]);
  assert.ok(planUpdates({ platform: 'linux' }).every(job => job.updateFormat === 'AppImage'));
});

test('missing production signing material stops before any build', () => {
  assert.throws(() => requireSigning(planUpdates({ platform: 'macos' }), {}), /签名/);
});

test('feed is generated from real final bytes and verified against an independent trust key', async t => {
  const f = await collection(t);
  const manifest = await verifyUpdateCollection(f.directory, f.publicKeys);
  assert.equal(manifest.artifacts[0].size, 128);
  const feed = JSON.parse(await readFile(path.join(f.directory, 'electron-macos-arm64-latest-mac.yml'), 'utf8'));
  assert.equal(feed.version, '0.1.1');
  assert.equal(feed.ineedChannel, 'electron-macos-arm64');
  assert.equal(feed.files[0].url, 'https://downloads.ineedfull.com/ineed-mqtt-tool/0.1.1/isolated-test/mqtt.zip');
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  await assert.rejects(verifyUpdateCollection(f.directory, { electron: other }), /signature|trust/i);
});

test('changed artifacts, metadata and extra files reject release verification', async t => {
  for (const target of ['mqtt.zip', 'electron-macos-arm64-latest-mac.yml', 'extra.txt']) {
    const f = await collection(t);
    await writeFile(path.join(f.directory, target), 'altered');
    await assert.rejects(verifyUpdateCollection(f.directory, f.publicKeys), /changed|Unexpected|size|checksum/i);
  }
});

test('upload verifies before transport and rejects same-key conflicts without overwriting', async t => {
  const f = await collection(t);
  let puts = 0;
  const transport = { stat: async () => ({ size: 128 }), put: async () => { puts++; }, sha256: async () => 'bad-digest' };
  await assert.rejects(uploadUpdates(f.directory, f.publicKeys, transport), /Remote/);
  assert.equal(puts, 0);
  await writeFile(path.join(f.directory, 'mqtt.zip'), 'broken');
  let touched = false;
  await assert.rejects(uploadUpdates(f.directory, f.publicKeys, { stat: async () => { touched = true; } }));
  assert.equal(touched, false);
});


test('production identities reject ad hoc, wrong teams and invalid Windows signatures', () => {
  const env = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Ineed (TEAM123)', APPLE_TEAM_ID: 'TEAM123' };
  const valid = 'Authority=Developer ID Application: Ineed (TEAM123)\nTeamIdentifier=TEAM123\n';
  validateMacIdentity(valid, env);
  assert.throws(() => validateMacIdentity('Signature=adhoc\n', env), /identity|team/i);
  assert.throws(() => validateMacIdentity(valid, { ...env, APPLE_TEAM_ID: 'OTHER' }), /team/i);
  const signature = { status: 'Valid', publisher: 'Ineed', thumbprint: 'AABB' };
  validateWindowsIdentity(signature, { INEED_WINDOWS_PUBLISHER: 'Ineed', INEED_WINDOWS_CERTIFICATE_THUMBPRINT: 'aa bb' });
  assert.throws(() => validateWindowsIdentity({ ...signature, status: 'NotSigned' }, { INEED_WINDOWS_PUBLISHER: 'Ineed' }), /signature/i);
  assert.throws(() => validateWindowsIdentity(signature, { INEED_WINDOWS_PUBLISHER: 'Other' }), /publisher/i);
});

test('private upload verifies every remote object and supports an identical retry', async t => {
  const f = await collection(t);
  const remote = new Map();
  const { createHash } = await import('node:crypto');
  let puts = 0;
  const transport = {
    stat: async key => remote.has(key) ? { size: remote.get(key).length } : null,
    put: async (file, key) => { remote.set(key, await readFile(file)); puts++; },
    sha256: async key => createHash('sha256').update(remote.get(key)).digest('hex'),
  };
  const receipt = await uploadUpdates(f.directory, f.publicKeys, transport);
  assert.equal(receipt.visibility, 'private');
  assert.equal(receipt.bucket, 'ineed-downloads');
  assert.equal(receipt.files.length, remote.size);
  const previousPuts = puts;
  assert.deepEqual(await uploadUpdates(f.directory, f.publicKeys, transport), receipt);
  assert.equal(puts, previousPuts);
});

test('compatibility feed is produced from the same verified manual installers', async t => {
  const f = await collection(t);
  const manifest = await verifyUpdateCollection(f.directory, f.publicKeys);
  assert.equal(manifest.compatibility.target, 'latest.json');
  const legacy = JSON.parse(await readFile(path.join(f.directory, 'latest.json'), 'utf8'));
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.appId, 'ineed-mqtt-tool');
  assert.equal(legacy.releases['electron-macos-arm64-dmg'].version, '0.1.1');
  assert.ok(legacy.releases['electron-macos-arm64-dmg'].url.endsWith('/mqtt.dmg'));
  const { createRequire } = await import('node:module');
  const { checkForUpdates } = createRequire(import.meta.url)('../apps/electron/electron/main.cjs');
  const result = await checkForUpdates({ platform: 'darwin', arch: 'arm64', currentVersion: '0.1.0',
    fetch: async () => new Response(JSON.stringify(legacy), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.available, true);
  assert.ok(result.url.endsWith('/mqtt.dmg'));
});
