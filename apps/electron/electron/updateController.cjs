'use strict';

const { createHash, verify, createPublicKey } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { lstat } = require('node:fs/promises');

function signedUpdatePayload(info) {
  return JSON.stringify({ channel: info.ineedChannel, version: info.version,
    files: info.files.map(({ url, size, sha512 }) => ({ url, size, sha512 })) });
}

function versionNumber(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) throw new Error('Invalid update version');
  const [major, minor, patch] = match.slice(1).map(Number);
  const number = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(number) || number > 2_147_483_647) throw new Error('Invalid update version');
  return number;
}

function validateMetadata(info, channel, publicKey, extension) {
  if (info?.ineedChannel !== channel) throw new Error('Invalid update channel');
  versionNumber(info.version);
  if (!Array.isArray(info.files) || info.files.length !== 1) throw new Error('Expected one update artifact');
  const file = info.files[0];
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || url.hostname !== 'downloads.ineedfull.com' || !url.pathname.startsWith('/ineed-mqtt-tool/')
    || !url.pathname.endsWith(extension)) throw new Error('Invalid HTTPS update artifact');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1_073_741_824) throw new Error('Invalid update size');
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(file.sha512)) throw new Error('Invalid update checksum');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof info.ineedSignature !== 'string'
    || !verify(null, Buffer.from(signedUpdatePayload(info)), key, Buffer.from(info.ineedSignature, 'base64'))) {
    throw new Error('Invalid update signature');
  }
}

async function verifyFile(file, expected) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) throw new Error('Update size mismatch');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('base64') !== expected.sha512) throw new Error('Update checksum mismatch');
}

function createUpdateController({ engine, currentVersion, platform = process.platform, arch = process.arch,
  appimage = Boolean(process.env.APPIMAGE), publicKey = '', prepare, onState = () => {},
  createCancellation = () => new (require('builder-util-runtime').CancellationToken)() } = {}) {
  const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform];
  const supported = Boolean(os && ['arm64', 'x64'].includes(arch) && (os === 'macos' || arch === 'x64')
    && (os !== 'linux' || appimage));
  const channel = `electron-${os}-${arch}`;
  const extension = { macos: '.zip', windows: '.exe', linux: '.AppImage' }[os];
  let state = { phase: 'idle', version: '', transferred: 0, total: 0, percent: 0, error: '',
    supported: Boolean(supported && publicKey), canCancel: true };
  let busy = false;
  let selected = null;
  let downloaded = null;
  let cancellation = null;

  function setState(patch) {
    state = { ...state, ...patch };
    try { onState({ ...state }); } catch { /* A destroyed renderer does not own native update state. */ }
    return { ...state };
  }
  engine.autoDownload = false;
  engine.autoInstallOnAppQuit = false;
  engine.allowDowngrade = false;
  engine.allowPrerelease = false;
  engine.disableWebInstaller = true;
  engine.on('error', error => {
    // Installer failure can arrive as an event after quitAndInstall has returned.
    if (state.phase === 'installing') setState({ phase: 'ready', error: error.message || String(error) });
  });
  engine.on('download-progress', progress => {
    if (state.phase !== 'downloading') return;
    const total = selected?.files[0].size || 0;
    const transferred = Math.max(0, Math.min(total, Number(progress.transferred) || 0));
    setState({ transferred, total, percent: total ? transferred * 100 / total : 0 });
  });

  async function exclusive(operation) {
    if (busy) throw new Error('Update is busy');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }

  return Object.freeze({
    getState: () => ({ ...state }),
    check: () => exclusive(async () => {
      selected = null;
      downloaded = null;
      try {
        if (!supported) throw new Error('unsupported automatic update installation');
        if (!publicKey) throw new Error('尚未配置更新签名');
        setState({ phase: 'checking', error: '', version: '', transferred: 0, percent: 0 });
        engine.setFeedURL({ provider: 'generic', url: `https://mqtt.ineedfull.com/updates/electron/${os}/${arch}/` });
        const result = await engine.checkForUpdates();
        if (!result?.updateInfo || versionNumber(result.updateInfo.version) <= versionNumber(currentVersion)) {
          setState({ phase: 'idle' });
          return { available: false, version: currentVersion, automatic: true };
        }
        validateMetadata(result.updateInfo, channel, publicKey, extension);
        // Own a snapshot; external metadata mutations cannot change what installation trusts.
        selected = JSON.parse(JSON.stringify(result.updateInfo));
        setState({ phase: 'available', version: selected.version, total: selected.files[0].size });
        return { available: true, version: selected.version, automatic: true, url: '', force: false,
          description: typeof selected.releaseNotes === 'string' ? selected.releaseNotes : '' };
      } catch (error) {
        setState({ phase: 'error', error: error.message });
        throw error;
      }
    }),
    download: () => exclusive(async () => {
      if (!selected || !['available', 'error'].includes(state.phase)) throw new Error('No available update');
      cancellation = createCancellation();
      try {
        setState({ phase: 'downloading', error: '', transferred: 0, percent: 0 });
        const paths = await engine.downloadUpdate(cancellation);
        if (cancellation.cancelled) throw new Error('下载已取消');
        setState({ phase: 'verifying' });
        if (!Array.isArray(paths) || paths.length !== 1) throw new Error('Invalid downloaded artifacts');
        await verifyFile(paths[0], selected.files[0]);
        if (cancellation.cancelled) throw new Error('下载已取消');
        downloaded = paths[0];
        return setState({ phase: 'ready', transferred: selected.files[0].size, percent: 100 });
      } catch (error) {
        downloaded = null;
        setState({ phase: cancellation.cancelled ? 'available' : 'error', error: error.message });
        throw error;
      } finally { cancellation = null; }
    }),
    cancel: async () => {
      if (!cancellation || state.phase !== 'downloading') throw new Error('No download to cancel');
      cancellation.cancel();
    },
    install: () => exclusive(async () => {
      if (!downloaded || state.phase !== 'ready') throw new Error('Update is not ready for installation');
      setState({ phase: 'preparing', error: '' });
      try {
        await verifyFile(downloaded, selected.files[0]);
        if (typeof prepare !== 'function') throw new Error('Update preparation unavailable');
        await prepare();
      } catch (error) {
        setState({ phase: 'ready', error: error.message });
        throw error;
      }
      setState({ phase: 'installing' });
      try { engine.quitAndInstall(false, true); } catch (error) {
        setState({ phase: 'ready', error: error.message });
        throw error;
      }
    }),
  });
}

module.exports = { createUpdateController, signedUpdatePayload, validateMetadata, verifyFile };
