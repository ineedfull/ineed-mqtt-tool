'use strict';

// Isolated desktop smoke markers and exit observation.
const fs = require('node:fs');
const { nonblankString } = require('./runtimeValidation.cjs');

function createSmokeExitGate({ beforeExit = () => {}, enabled, exitProcess = () => {} } = {}) {
  let cleanupComplete = false;
  let exited = false;
  const exit = enabled ? exitProcess : () => {};
  const destroyedWindows = new Map();

  function destroyWindow(role, window) {
    if (window && !window.isDestroyed()) window.destroy();
    if (window?.isDestroyed() !== true) throw new Error(`${role} window did not close`);
    destroyedWindows.set(role, window);
  }

  function maybeExit() {
    if (
      !enabled
      || exited
      || !cleanupComplete
      || destroyedWindows.get('main')?.isDestroyed() !== true
      || destroyedWindows.get('history')?.isDestroyed() !== true
    ) return;
    exited = true;
    exit((beforeExit(), 0));
  }

  return Object.freeze({
    markCleanupComplete() {
      cleanupComplete = true;
      maybeExit();
    },
    markWindowDestroyed(role, window) {
      if ((role === 'main' || role === 'history') && window?.isDestroyed() === true) {
        destroyedWindows.set(role, window);
      }
      maybeExit();
    },
    destroyFinalWindowAndExit(role, window) {
      if (
        !enabled
        || exited
        || !cleanupComplete
        || role !== 'main'
        || destroyedWindows.get('history')?.isDestroyed() !== true
      ) return false;
      exited = true;
      exit((destroyWindow(role, window), beforeExit(), 0));
      return true;
    },
  });
}

function readSmokeHistoryKind(env, smokeTest) {
  if (!smokeTest) return null;
  const kind = nonblankString(env?.INEED_SMOKE_HISTORY);
  if (kind !== 'messages' && kind !== 'logs') {
    throw new TypeError('INEED_SMOKE_HISTORY must be messages or logs');
  }
  return kind;
}

function writeSmokeMarker({
  marker = 'mqtt-tool-history-closed',
  onError = () => {},
  write = fs.writeSync,
} = {}) {
  try {
    write(1, `${marker}\n`);
    return true;
  } catch (error) {
    try { onError(error); } catch { /* Marker failure reporting must stay contained. */ }
    return false;
  }
}

module.exports = { createSmokeExitGate, readSmokeHistoryKind, writeSmokeMarker };
