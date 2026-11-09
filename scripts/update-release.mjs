#!/usr/bin/env node
// MQTT updater artifacts supplement the shared manual-installer workflow.
import assert from 'node:assert/strict';
import { createHash, sign, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, lstat, copyFile, open, rename, rm } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectJobs, parseOptions, readProduct, buildCommands, checkContainer, sha256 } from './desktop-release.mjs';
import { objectKey, createSshTransport } from './release-upload.mjs';
const require = createRequire(import.meta.url);
const { signedUpdatePayload, validateMetadata } = require('../apps/electron/electron/updateController.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const updateFormats = { electron: { macos: 'zip', windows: 'nsis', linux: 'AppImage' }, tauri: { macos: 'app-tar-gz', windows: 'nsis', linux: 'AppImage' } };
const suffixes = { zip: '.zip', 'app-tar-gz': '.app.tar.gz', nsis: '.exe', AppImage: '.AppImage' };
const tauriChannel = artifact => `tauri-${artifact.platform}-${artifact.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
const electronChannel = artifact => `electron-${artifact.platform}-${artifact.arch}`;
const targetFor = artifact => artifact.runtime === 'electron'
  ? `electron/${artifact.platform}/${artifact.arch}/${{ macos: 'latest-mac.yml', windows: 'latest.yml', linux: 'latest-linux.yml' }[artifact.platform]}`
  : `tauri/${tauriChannel(artifact)}.json`;
const feedName = artifact => targetFor(artifact).replaceAll('/', '-');

export function planUpdates(options = {}) {
  return selectJobs(options).map(job => ({ ...job, updateFormat: updateFormats[job.runtime][job.platform],
    formats: job.runtime === 'electron' && job.platform === 'macos' ? ['dmg', 'zip'] : [job.platform === 'macos' ? 'dmg' : job.platform === 'windows' ? 'nsis' : 'AppImage'] }));
}

export function requireSigning(jobs, env = process.env) {
  for (const job of jobs) {
    if (job.runtime === 'electron') assert.ok(env.INEED_ELECTRON_UPDATE_PUBLIC_KEY_FILE && env.INEED_ELECTRON_UPDATE_PRIVATE_KEY_FILE, '缺少 Electron 更新签名密钥文件');
    else assert.ok(env.INEED_TAURI_UPDATE_PUBLIC_KEY_FILE && env.TAURI_SIGNING_PRIVATE_KEY_PATH, '缺少 Tauri 更新签名密钥文件');
    if (job.platform === 'macos') assert.ok(env.APPLE_SIGNING_IDENTITY && env.APPLE_TEAM_ID, '缺少 macOS 正式签名配置');
    if (job.platform === 'windows') assert.ok(env.INEED_WINDOWS_PUBLISHER && (job.runtime === 'electron' ? env.CSC_LINK : env.INEED_WINDOWS_CERTIFICATE_THUMBPRINT), '缺少 Windows 正式签名配置');
  }
}

export function validateMacIdentity(output, env = process.env) {
  assert.ok(output.includes(`Authority=${env.APPLE_SIGNING_IDENTITY}\n`) && env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:'), 'Unexpected macOS signing identity');
  assert.ok(output.includes(`TeamIdentifier=${env.APPLE_TEAM_ID}\n`), 'Unexpected macOS signing team');
}

export function validateWindowsIdentity(signature, env = process.env) {
  assert.equal(signature.status, 'Valid', 'Invalid Windows Authenticode signature');
  assert.equal(signature.publisher, env.INEED_WINDOWS_PUBLISHER, 'Unexpected Windows publisher');
  if (env.INEED_WINDOWS_CERTIFICATE_THUMBPRINT) {
    const normalize = value => String(value).replaceAll(/\s/gu, '').toUpperCase();
    assert.equal(normalize(signature.thumbprint), normalize(env.INEED_WINDOWS_CERTIFICATE_THUMBPRINT), 'Unexpected Windows certificate');
  }
}

function compatibilityFeed(manifest) {
  const releases = {};
  const installers = [...manifest.installers, ...manifest.artifacts.filter(a => a.platform !== 'macos')];
  for (const artifact of installers) {
    const format = artifact.format === 'AppImage' ? 'appimage' : artifact.format;
    const channel = `${artifact.runtime}-${artifact.platform}-${artifact.arch}-${format}`;
    assert.equal(Object.hasOwn(releases, channel), false, 'Duplicate compatibility channel');
    releases[channel] = { version: manifest.product.version,
      url: `https://downloads.ineedfull.com/${objectKey(manifest, artifact)}`,
      force: false, description: 'MQTT Tool 更新' };
  }
  return { schemaVersion: 1, appId: 'ineed-mqtt-tool', releases };
}

async function publicKeysFor(jobs) {
  const publicKeys = {};
  for (const runtime of new Set(jobs.map(job => job.runtime))) {
    const file = process.env[runtime === 'electron' ? 'INEED_ELECTRON_UPDATE_PUBLIC_KEY_FILE' : 'INEED_TAURI_UPDATE_PUBLIC_KEY_FILE'];
    assert.ok(file, `缺少 ${runtime} 更新公钥文件`);
    publicKeys[runtime] = (await readFile(file, 'utf8')).trim();
    if (runtime === 'electron') assert.equal(createPublicKey(publicKeys[runtime]).asymmetricKeyType, 'ed25519', 'Expected Ed25519 update key');
  }
  return publicKeys;
}

async function sha512(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

async function fileRecord(directory, name, kind) {
  assert.match(name, safeName, 'Unsafe update filename');
  const stat = await lstat(path.join(directory, name));
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'Expected regular update file');
  return { name, kind, size: stat.size, sha256: await sha256(path.join(directory, name)) };
}

function tauriSignature(operation, file, signatureFile, version, publicKey) {
  execFileSync('cargo', ['run', '--quiet', '--locked', '--manifest-path', path.join(root, 'apps/tauri/src-tauri/Cargo.toml'),
    '--features', 'release-signing', '--bin', 'update_signature', '--', operation, file, signatureFile, version],
  { env: { ...process.env, INEED_TAURI_UPDATE_PUBLIC_KEY: publicKey }, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function verifyContainer(directory, artifact) {
  const file = path.join(directory, artifact.name);
  if (['nsis', 'AppImage'].includes(artifact.format)) return checkContainer(file, artifact.format);
  const header = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    await header.read(bytes, 0, 4, 0);
    if (artifact.format === 'zip') assert.equal(bytes.toString('hex'), '504b0304', 'Invalid update ZIP');
    else if (artifact.format === 'app-tar-gz') assert.equal(bytes.subarray(0, 2).toString('hex'), '1f8b', 'Invalid update gzip');
    else throw new Error('Unsupported update format');
  } finally { await header.close(); }
}

function electronFeed(manifest, artifact) {
  return { version: manifest.product.version, ineedChannel: electronChannel(artifact),
    files: [{ url: `https://downloads.ineedfull.com/${objectKey(manifest, artifact)}`, size: artifact.size, sha512: artifact.sha512 }] };
}

export async function writeUpdateCollection(directory, input, privateKeys) {
  assert.match(input.version, /^\d+\.\d+\.\d+$/u, 'Invalid update version');
  assert.match(input.buildId, safeName, 'Unsafe build ID');
  const manifest = { schemaVersion: 1, kind: 'mqtt-updates', product: { slug: 'ineed-mqtt-tool', version: input.version },
    buildId: input.buildId, sourceCommit: input.sourceCommit ?? null, sourceDirty: input.sourceDirty ?? null,
    artifacts: [], installers: [], files: [], feeds: [], compatibility: { name: 'latest.json', target: 'latest.json' } };
  for (const descriptor of input.artifacts) {
    assert.equal(descriptor.format, updateFormats[descriptor.runtime]?.[descriptor.platform], 'Wrong update format');
    assert.ok(descriptor.arch === 'x64' || (descriptor.platform === 'macos' && descriptor.arch === 'arm64'), 'Wrong update architecture');
    const file = await fileRecord(directory, descriptor.name, 'artifact');
    const artifact = { ...descriptor, ...file, sha512: await sha512(path.join(directory, descriptor.name)) };
    await verifyContainer(directory, artifact);
    manifest.artifacts.push(artifact);
    manifest.files.push(file);
    let feed;
    if (artifact.runtime === 'electron') {
      feed = electronFeed(manifest, artifact);
      feed.ineedSignature = sign(null, Buffer.from(signedUpdatePayload(feed)), privateKeys.electron).toString('base64');
      validateMetadata(feed, electronChannel(artifact), input.publicKeys.electron, suffixes[artifact.format]);
    } else {
      const signatureName = `${artifact.name}.sig`;
      tauriSignature('sign', path.join(directory, artifact.name), path.join(directory, signatureName), input.version, input.publicKeys.tauri);
      const signature = (await readFile(path.join(directory, signatureName), 'utf8')).trim();
      manifest.files.push(await fileRecord(directory, signatureName, 'signature'));
      feed = { version: input.version, platforms: { [tauriChannel(artifact)]: {
        url: `https://downloads.ineedfull.com/${objectKey(manifest, artifact)}`, signature } } };
    }
    const name = feedName(artifact);
    // JSON is also valid YAML; preserve exactly the signed fields instead of reformatting them.
    await writeFile(path.join(directory, name), `${JSON.stringify(feed, null, 2)}\n`, { flag: 'wx' });
    manifest.files.push(await fileRecord(directory, name, 'metadata'));
    manifest.feeds.push({ name, target: targetFor(artifact), runtime: artifact.runtime, artifactName: artifact.name });
  }
  for (const descriptor of input.manualInstallers ?? []) {
    assert.equal(descriptor.platform, 'macos');
    assert.equal(descriptor.format, 'dmg');
    assert.ok(['electron', 'tauri'].includes(descriptor.runtime) && ['arm64', 'x64'].includes(descriptor.arch));
    const file = await fileRecord(directory, descriptor.name, 'installer');
    await checkContainer(path.join(directory, descriptor.name), 'dmg');
    manifest.installers.push({ ...descriptor, ...file });
    manifest.files.push(file);
  }
  await writeFile(path.join(directory, 'latest.json'), `${JSON.stringify(compatibilityFeed(manifest), null, 2)}\n`, { flag: 'wx' });
  manifest.files.push(await fileRecord(directory, 'latest.json', 'compatibility'));
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await verifyUpdateCollection(directory, input.publicKeys);
  return manifest;
}

export async function verifyUpdateCollection(directory, trustedKeys) {
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected real update collection');
  const manifestStat = await lstat(path.join(directory, 'manifest.json'));
  assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink(), 'Expected regular manifest');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'mqtt-updates');
  assert.equal(manifest.product.slug, 'ineed-mqtt-tool');
  assert.match(manifest.product.version, /^\d+\.\d+\.\d+$/u);
  assert.match(manifest.buildId, safeName);
  assert.ok(manifest.artifacts.length > 0 && manifest.feeds.length === manifest.artifacts.length, 'Incomplete update matrix');
  const expectedNames = ['manifest.json', ...manifest.files.map(file => file.name)];
  assert.equal(new Set(expectedNames).size, expectedNames.length, 'Duplicate collection file');
  const entries = (await readdir(directory)).filter(name => name !== 'build-logs');
  assert.deepEqual(entries.sort(), expectedNames.sort(), 'Unexpected or missing update files');
  for (const file of manifest.files) {
    const current = await fileRecord(directory, file.name, file.kind);
    assert.deepEqual(current, file, 'Update file changed');
  }
  const channels = new Set();
  for (const artifact of manifest.artifacts) {
    assert.equal(artifact.format, updateFormats[artifact.runtime]?.[artifact.platform], 'Wrong update format');
    assert.ok(artifact.arch === 'x64' || (artifact.platform === 'macos' && artifact.arch === 'arm64'), 'Wrong update architecture');
    assert.equal(channels.has(`${artifact.runtime}-${artifact.platform}-${artifact.arch}`), false, 'Duplicate update channel');
    channels.add(`${artifact.runtime}-${artifact.platform}-${artifact.arch}`);
    assert.deepEqual(manifest.files.find(file => file.name === artifact.name),
      { name: artifact.name, kind: 'artifact', size: artifact.size, sha256: artifact.sha256 }, 'Artifact/file mismatch');
    assert.equal(await sha512(path.join(directory, artifact.name)), artifact.sha512, 'Update checksum changed');
    await verifyContainer(directory, artifact);
    const metadata = manifest.feeds.find(feed => feed.artifactName === artifact.name);
    assert.deepEqual(metadata, { name: feedName(artifact), target: targetFor(artifact), runtime: artifact.runtime, artifactName: artifact.name }, 'Invalid update feed target');
    const feed = JSON.parse(await readFile(path.join(directory, metadata.name), 'utf8'));
    assert.equal(feed.version, manifest.product.version, 'Update version mismatch');
    if (artifact.runtime === 'electron') {
      assert.ok(trustedKeys?.electron, 'Missing independent update trust key');
      validateMetadata(feed, electronChannel(artifact), trustedKeys.electron, suffixes[artifact.format]);
      assert.deepEqual(feed.files, electronFeed(manifest, artifact).files, 'Update artifact mismatch');
    } else {
      assert.ok(trustedKeys?.tauri, 'Missing independent update trust key');
      const release = feed.platforms[tauriChannel(artifact)];
      assert.equal(release.url, `https://downloads.ineedfull.com/${objectKey(manifest, artifact)}`);
      const signatureName = `${artifact.name}.sig`;
      assert.equal(release.signature, (await readFile(path.join(directory, signatureName), 'utf8')).trim());
      tauriSignature('verify', path.join(directory, artifact.name), path.join(directory, signatureName), manifest.product.version, trustedKeys.tauri);
    }
  }
  assert.deepEqual(manifest.compatibility, { name: 'latest.json', target: 'latest.json' });
  for (const installer of manifest.installers) {
    assert.equal(installer.platform, 'macos');
    assert.equal(installer.format, 'dmg');
    assert.ok(['electron', 'tauri'].includes(installer.runtime) && ['arm64', 'x64'].includes(installer.arch));
    assert.deepEqual(manifest.files.find(file => file.name === installer.name),
      { name: installer.name, kind: 'installer', size: installer.size, sha256: installer.sha256 });
    await checkContainer(path.join(directory, installer.name), 'dmg');
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8')), compatibilityFeed(manifest), 'Invalid compatibility feed');
  return manifest;
}

export async function uploadUpdates(directory, publicKeys, transport = createSshTransport()) {
  const manifest = await verifyUpdateCollection(directory, publicKeys);
  const uploaded = [];
  for (const file of manifest.files) {
    const key = objectKey(manifest, file);
    const existing = await transport.stat(key);
    if (existing === null) await transport.put(path.join(directory, file.name), key);
    const remote = existing ?? await transport.stat(key);
    assert.equal(remote?.size, file.size, 'Remote size mismatch');
    assert.equal(await transport.sha256(key), file.sha256, 'Remote SHA-256 mismatch');
    uploaded.push({ ...file, key });
  }
  return { product: manifest.product, buildId: manifest.buildId, bucket: 'ineed-downloads', visibility: 'private', files: uploaded };
}

async function runCommand(spec, log) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd ?? root, env: { ...process.env, ...spec.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  await writeFile(log, result.output);
  assert.equal(result.code, 0, `Update build failed; see ${log}`);
}

async function buildUpdates(options) {
  const jobs = planUpdates(options);
  requireSigning(jobs);
  assert.equal({ darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform], jobs[0].platform, 'Build on target OS');
  const publicKeys = await publicKeysFor(jobs);
  const privateKeys = {};
  if (publicKeys.electron) privateKeys.electron = createPrivateKey(await readFile(process.env.INEED_ELECTRON_UPDATE_PRIVATE_KEY_FILE));
  const product = await readProduct();
  const buildId = `${product.version}-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, 'release', 'updates');
  await mkdir(directory, { recursive: true });
  assert.ok(!(await lstat(directory)).isSymbolicLink(), 'Update output must not be a symlink');
  const lockDirectory = path.join(root, 'release', 'desktop');
  await mkdir(lockDirectory, { recursive: true });
  const lock = await open(path.join(lockDirectory, '.build-lock'), 'wx');
  const stage = path.join(directory, `.stage-${buildId}`);
  try {
    await mkdir(stage);
    const logs = path.join(stage, 'build-logs'); await mkdir(logs);
    const artifacts = [];
    const manualInstallers = [];
    for (const job of jobs) {
      const native = path.join(logs, `native-${job.runtime}-${job.arch}`);
      const commands = buildCommands(root, job, native);
      if (job.runtime === 'electron') {
        const config = JSON.parse(await readFile(path.join(root, 'apps/electron/package.json'), 'utf8')).build;
        config.publish = [{ provider: 'generic', url: `https://mqtt.ineedfull.com/updates/electron/${job.platform}/${job.arch}/` }];
        config.forceCodeSigning = job.platform !== 'linux';
        if (job.platform === 'macos') config.mac.identity = process.env.APPLE_SIGNING_IDENTITY;
        if (job.platform === 'windows') config.win.publisherName = process.env.INEED_WINDOWS_PUBLISHER;
        const trust = path.join(logs, `trust-${job.arch}.json`);
        await writeFile(trust, JSON.stringify({ schemaVersion: 1, publicKey: publicKeys.electron }));
        config.extraResources = [{ from: trust, to: 'mqtt-update-trust.json' }];
        const configFile = path.join(logs, `electron-${job.arch}.json`);
        await writeFile(configFile, JSON.stringify(config));
        commands.at(-1).args.push(`--config=${configFile}`, '--publish=never');
      } else {
        const bundle = { createUpdaterArtifacts: true };
        if (job.platform === 'macos') bundle.macOS = { signingIdentity: process.env.APPLE_SIGNING_IDENTITY };
        if (job.platform === 'windows') bundle.windows = { certificateThumbprint: process.env.INEED_WINDOWS_CERTIFICATE_THUMBPRINT, digestAlgorithm: 'sha256' };
        const configFile = path.join(logs, `tauri-${job.arch}.json`);
        await writeFile(configFile, JSON.stringify({ bundle, plugins: { updater: { pubkey: publicKeys.tauri, requireSignedVersion: true } } }));
        const command = commands[0];
        command.args.splice(command.args.indexOf('--'), 0, '--config', configFile);
        command.env = { ...command.env, INEED_TAURI_UPDATE_PUBLIC_KEY: publicKeys.tauri,
          TAURI_SIGNING_PRIVATE_KEY: (await readFile(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH, 'utf8')).trim() };
      }
      for (let i = 0; i < commands.length; i++) await runCommand(commands[i], path.join(logs, `${job.runtime}-${job.arch}-${i}.log`));
      const sourceDirectory = job.runtime === 'electron' ? native : path.join(native, job.rustTarget, 'release', 'bundle', job.platform === 'macos' ? 'macos' : job.platform === 'windows' ? 'nsis' : 'appimage');
      const files = await readdir(sourceDirectory);
      if (job.platform === 'macos') {
        const appDirectory = job.runtime === 'electron' ? path.join(native, job.arch === 'arm64' ? 'mac-arm64' : 'mac') : sourceDirectory;
        const applications = (await readdir(appDirectory)).filter(name => name.endsWith('.app'));
        assert.equal(applications.length, 1, 'Expected one signed application');
        const application = path.join(appDirectory, applications[0]);
        execFileSync('codesign', ['--verify', '--deep', '--strict', application], { stdio: 'pipe' });
        const identity = spawnSync('codesign', ['-dv', '--verbose=4', application], { encoding: 'utf8' });
        assert.equal(identity.status, 0, 'Cannot inspect macOS signing identity');
        validateMacIdentity(identity.stderr);
        execFileSync('spctl', ['--assess', '--type', 'execute', application], { stdio: 'pipe' });
      }
      const candidates = files.filter(name => name.endsWith(suffixes[job.updateFormat]));
      assert.equal(candidates.length, 1, 'Expected one native update artifact');
      if (job.platform === 'windows') {
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '$s=Get-AuthenticodeSignature -LiteralPath $env:INEED_VERIFY_INSTALLER; @{status=[string]$s.Status; publisher=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false); thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress'],
        { encoding: 'utf8', env: { ...process.env, INEED_VERIFY_INSTALLER: path.join(sourceDirectory, candidates[0]) } });
        validateWindowsIdentity(JSON.parse(output.replace(/^\uFEFF/u, '')));
      }
      if (job.platform === 'macos') {
        const dmgDirectory = job.runtime === 'electron' ? native : path.join(native, job.rustTarget, 'release/bundle/dmg');
        const dmgs = (await readdir(dmgDirectory)).filter(file => file.endsWith('.dmg'));
        assert.equal(dmgs.length, 1, 'Expected one compatibility DMG');
        const name = `${product.slug}-${product.version}-${job.runtime}-macos-${job.arch}.dmg`;
        await copyFile(path.join(dmgDirectory, dmgs[0]), path.join(stage, name));
        manualInstallers.push({ runtime: job.runtime, platform: 'macos', arch: job.arch, format: 'dmg', name });
      }
      const name = `${product.slug}-${product.version}-${job.runtime}-${job.platform}-${job.arch}${suffixes[job.updateFormat]}`;
      await copyFile(path.join(sourceDirectory, candidates[0]), path.join(stage, name));
      artifacts.push({ runtime: job.runtime, platform: job.platform, arch: job.arch, format: job.updateFormat, name });
    }
    await writeUpdateCollection(stage, { version: product.version, buildId, publicKeys, artifacts, manualInstallers,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) }, privateKeys);
    const destination = path.join(directory, buildId);
    await rename(stage, destination);
    console.log(`UPDATE_RELEASE_DIRECTORY=${destination}`);
  } finally {
    await lock.close();
    await rm(path.join(lockDirectory, '.build-lock'));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = parseOptions(args);
    if (command === 'plan') console.log(JSON.stringify(planUpdates(options), null, 2));
    else if (command === 'build') await buildUpdates(options);
    else if (['verify', 'upload'].includes(command)) {
      assert.ok(options.dir && path.isAbsolute(options.dir), 'Use --dir=/absolute/update/collection');
      const manifest = JSON.parse(await readFile(path.join(options.dir, 'manifest.json'), 'utf8'));
      const keys = await publicKeysFor(manifest.artifacts);
      if (command === 'verify') { await verifyUpdateCollection(options.dir, keys); console.log('Update collection verified; native installation and public delivery remain separate checks.'); }
      else {
        const receipt = await uploadUpdates(options.dir, keys);
        const receipts = path.join(root, 'release/uploads/ineed-downloads'); await mkdir(receipts, { recursive: true });
        const file = path.join(receipts, `updates-${receipt.buildId}.json`);
        await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
        console.log(`UPLOAD_RECEIPT=${file}`);
      }
    } else throw new Error('Use plan|build|verify|upload');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
