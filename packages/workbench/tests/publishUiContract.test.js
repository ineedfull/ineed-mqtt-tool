import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shellSource = await readFile(
  new URL('../src/layouts/MqttToolShell.vue', import.meta.url),
  'utf8',
);
const cssSource = await readFile(
  new URL('../src/styles/base.css', import.meta.url),
  'utf8',
);

function sourceBetween(start, end) {
  const startIndex = shellSource.indexOf(start);
  const endIndex = shellSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return shellSource.slice(startIndex, endIndex);
}

test('manual publishing awaits broker success before recording it once', () => {
  const workflow = sourceBetween('async function realPublish()', 'onUnmounted(() =>');
  const brokerIndex = workflow.indexOf('await publishOnce(');
  const recordingIndex = workflow.indexOf('await recordPublishSuccess(');

  assert.notEqual(brokerIndex, -1);
  assert.ok(recordingIndex > brokerIndex);
  assert.match(workflow, /if \(!result\.ok\)[\s\S]*return false/);
  assert.doesNotMatch(workflow, /\bdoPublish\s*\(/);
});

test('timed publishing uses the guarded broker workflow and validates its interval', () => {
  const timer = sourceBetween('function toggleTimer()', '// Draggable splitter');

  assert.match(timer, /void realPublish\(\)/);
  assert.doesNotMatch(timer, /\bdoPublish\s*\(/);
  assert.match(timer, /Number\.isFinite\(interval\)/);
  assert.match(timer, /Number\.isInteger\(interval\)/);
  assert.match(timer, /interval < 1 \|\| interval > 999/);
});

test('publish timers are reset through one helper during unmount', () => {
  const unmount = sourceBetween('onUnmounted(() =>', '// Timed publish');
  const stopTimer = sourceBetween('function stopPublishTimer()', 'function toggleTimer()');

  assert.match(unmount, /stopPublishTimer\(\)/);
  assert.match(stopTimer, /clearInterval\(timerId\)/);
  assert.match(stopTimer, /timerId = null/);
  assert.match(stopTimer, /timerRunning\.value = false/);
  assert.match(stopTimer, /timerCountdown\.value = 0/);
});

test('publish controls expose connection, validation, overlap, and error states', () => {
  const template = shellSource.slice(shellSource.indexOf('<template>'));

  assert.match(template, /class="publish-bar__timer-btn"[^>]*:disabled="!canStartTimer"/);
  assert.match(template, /class="publish-bar__send"[^>]*:disabled="!canPublish"/);
  assert.match(template, /\{\{ publishing \? '发送中\.\.\.' : '发送' \}\}/);
  assert.match(template, /v-if="publishError" class="publish-bar__error" role="alert">\{\{ publishError \}\}/);
  assert.match(cssSource, /\.publish-bar__error\s*\{[^}]*color:\s*var\(--error\)/s);
});
