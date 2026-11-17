'use strict';

// Checks bounded HTTPS update manifests; install preparation remains in updateController.


const UPDATE_TIMEOUT_MS = 10_000;

const UPDATE_RESPONSE_MAX_BYTES = 65_536;

const UPDATE_ENDPOINT = 'https://mqtt.ineedfull.com/updates/latest.json';

const CURRENT_VERSION = require('../package.json').version;

function isSafeExternalUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hostname !== '';
  } catch {
    return false;
  }
}

async function checkForUpdates({
  fetch,
  endpoint = UPDATE_ENDPOINT,
  timeoutMs = UPDATE_TIMEOUT_MS,
  platform = process.platform,
  arch = process.arch,
  appImage = Boolean(process.env.APPIMAGE),
  currentVersion = CURRENT_VERSION,
} = {}) {
  if (typeof fetch !== 'function') throw new TypeError('Update fetch is unavailable');
  if (!isSafeExternalUrl(endpoint)) throw new TypeError('Invalid update endpoint');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Update timeout must be a positive finite number');
  }
  const platformName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform];
  if (!platformName || !['arm64', 'x64'].includes(arch) || (platformName !== 'macos' && arch !== 'x64')) {
    throw new TypeError('Unsupported update platform');
  }
  const format = platformName === 'macos' ? 'dmg' : platformName === 'windows' ? 'nsis' : appImage ? 'appimage' : 'deb';
  const versionParts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(currentVersion);
  if (!versionParts) throw new TypeError('Invalid current update version');
  const [, major, minor, patch] = versionParts.map(Number);
  const currentNumberVersion = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || currentNumberVersion > 2_147_483_647) {
    throw new TypeError('Current update version exceeds numeric version range');
  }
  const controller = new AbortController();
  const timeoutError = new Error('Update check timed out');
  let timedOut = false;
  let response = null;
  let responseBody = null;
  let reader = null;
  let bodyComplete = false;
  let cancellationStarted = false;
  let failure = null;
  let rejectOnTimeout;
  const timeout = new Promise((resolve, reject) => {
    void resolve;
    rejectOnTimeout = reject;
  });
  const cancelResponseBody = reason => {
    if (cancellationStarted || bodyComplete) return;
    cancellationStarted = true;
    try {
      if (!reader && typeof responseBody?.cancel !== 'function' && typeof responseBody?.getReader === 'function') {
        reader = responseBody.getReader();
      }
      const cancellation = typeof reader?.cancel === 'function'
        ? reader.cancel(reason)
        : responseBody?.cancel?.(reason);
      Promise.resolve(cancellation).catch(() => {});
    } catch { /* Reader cancellation is best-effort. */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancelResponseBody(timeoutError);
    controller.abort(timeoutError);
    rejectOnTimeout(timeoutError);
  }, timeoutMs);
  try {
    response = await Promise.race([
      fetch(endpoint, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
      }),
      timeout,
    ]);
    responseBody = response?.body ?? null;
    if (!response?.ok) throw new Error(`Update check failed (${response?.status || 'unknown'})`);

    let contentLength = null;
    const declaredLength = response.headers?.get?.('content-length');
    if (declaredLength !== null && declaredLength !== undefined) {
      if (typeof declaredLength !== 'string' || !/^\d+$/.test(declaredLength)) {
        throw new TypeError('Invalid update Content-Length');
      }
      contentLength = Number(declaredLength);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new TypeError('Invalid update Content-Length');
      }
      if (contentLength > UPDATE_RESPONSE_MAX_BYTES) {
        throw new RangeError('Update response is too large');
      }
    }

    let text;
    if (typeof responseBody?.getReader === 'function') {
      reader = responseBody.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let receivedBytes = 0;
      text = '';
      while (true) {
        const chunk = await Promise.race([reader.read(), timeout]);
        if (chunk?.done) break;
        if (!(chunk?.value instanceof Uint8Array)) {
          throw new TypeError('Invalid update response stream');
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > UPDATE_RESPONSE_MAX_BYTES) {
          const sizeError = new RangeError('Update response is too large');
          cancelResponseBody(sizeError);
          controller.abort(sizeError);
          throw sizeError;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      bodyComplete = true;
      text += decoder.decode();
    } else {
      if (contentLength === null) {
        throw new TypeError('Update Content-Length is required without a response stream');
      }
      if (typeof response.text !== 'function') throw new TypeError('Invalid update response text');
      text = await Promise.race([response.text(), timeout]);
      bodyComplete = true;
      if (typeof text !== 'string') throw new TypeError('Invalid update response text');
      if (Buffer.byteLength(text, 'utf8') > UPDATE_RESPONSE_MAX_BYTES) {
        throw new RangeError('Update response is too large');
      }
    }
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new TypeError('Invalid update response');
    }
    if (body.schemaVersion !== 1) throw new TypeError('Invalid update schemaVersion');
    if (body.appId !== 'ineed-mqtt-tool') throw new TypeError('Invalid update appId');
    if (body.releases === null || typeof body.releases !== 'object' || Array.isArray(body.releases)) {
      throw new TypeError('Invalid update releases');
    }
    const release = body.releases[`electron-${platformName}-${arch}-${format}`];
    if (release === undefined) {
      return { available: false, version: currentVersion, url: '', force: false, description: '' };
    }
    if (release === null || typeof release !== 'object' || Array.isArray(release)) {
      throw new TypeError('Invalid update release');
    }
    if (typeof release.version !== 'string') throw new TypeError('Invalid update version');
    const releaseParts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(release.version);
    if (!releaseParts || release.version.length > 128) throw new TypeError('Invalid update version');
    const [, releaseMajor, releaseMinor, releasePatch] = releaseParts.map(Number);
    const releaseNumberVersion = releaseMajor * 1_000_000 + releaseMinor * 1_000 + releasePatch;
    if (releaseMinor > 999 || releasePatch > 999 || releaseNumberVersion > 2_147_483_647) {
      throw new TypeError('Invalid update version');
    }
    if (!isSafeExternalUrl(release.url)) throw new TypeError('Invalid update url');
    if (release.force != null && typeof release.force !== 'boolean') throw new TypeError('Invalid update force');
    if (release.description != null && typeof release.description !== 'string') {
      throw new TypeError('Invalid update description');
    }
    if (releaseNumberVersion <= currentNumberVersion) {
      return { available: false, version: currentVersion, url: '', force: false, description: '' };
    }
    return {
      available: true,
      version: release.version,
      url: new URL(release.url).toString(),
      force: release.force ?? false,
      description: release.description || '',
    };
  } catch (error) {
    failure = timedOut ? timeoutError : error;
    throw failure;
  } finally {
    clearTimeout(timer);
    if (response !== null && !bodyComplete) {
      cancelResponseBody(failure || new Error('Update response was not consumed'));
      if (!controller.signal.aborted) controller.abort(failure);
    }
  }
}

module.exports = { isSafeExternalUrl, checkForUpdates };
