import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { formatHistoryTime, toHistoryTimestamp } from '../src/workspace/historyTime.js';

test('formatHistoryTime keeps millisecond precision for history timestamps', () => {
  assert.equal(formatHistoryTime({ created_at: '2026-07-09 14:38:12.045' }), '2026-07-09 14:38:12.045');
  assert.equal(formatHistoryTime({ created_at: '2026-07-09 14:38:12' }), '2026-07-09 14:38:12.000');
  assert.equal(formatHistoryTime({ time: '14:38:12' }), '14:38:12.000');
  assert.equal(formatHistoryTime({ time: '14:38:12.7' }), '14:38:12.700');
});

test('Tauri empty created_at falls back to legacy time without discarding epoch zero or masking invalid values', () => {
  const row = { id: 7, connection_id: 'connection-1', time: '14:38:12.7', level: 'debug', msg: 'legacy log', created_at: '' };
  for (const created_at of [undefined, null, '', ' \t ']) {
    assert.equal(formatHistoryTime({ ...row, created_at }), '14:38:12.700');
  }
  assert.equal(formatHistoryTime({ ...row, created_at: 0 }), formatHistoryTime({ created_at: 0 }));
  assert.notEqual(formatHistoryTime({ ...row, created_at: 0 }), '14:38:12.700');
  for (const created_at of ['invalid', '2026-02-30 12:00:00', false]) {
    assert.equal(formatHistoryTime({ ...row, created_at }), '--');
  }
});

test('toHistoryTimestamp generates database timestamps with milliseconds', () => {
  const date = new Date(2026, 6, 9, 14, 38, 12, 45);

  assert.equal(toHistoryTimestamp(date), '2026-07-09 14:38:12.045');
});

test('history converts explicit timezone instants and rejects invalid legacy dates without altering stored rows', () => {
  const row = { created_at: '2026-07-09T06:38:12.045Z', time: 'old' };
  const expected = toHistoryTimestamp(new Date('2026-07-09T06:38:12.045Z'));
  assert.equal(formatHistoryTime(row), expected);
  assert.equal(row.created_at, '2026-07-09T06:38:12.045Z');
  assert.notEqual(formatHistoryTime({ created_at: 0 }), '--');
  for (const value of ['', 'garbage', '2026-02-30 12:00:00', '2026-07-09 25:00:00', '2026-07-09 14:38:12junk', '25:00:00']) {
    assert.equal(formatHistoryTime({ created_at: value }), '--', value);
  }
});

test('legacy wall times keep their stored fields when the current timezone has a DST gap', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { formatHistoryTime } from ${JSON.stringify(new URL('../src/workspace/historyTime.js', import.meta.url).href)};
    console.log(formatHistoryTime({ created_at: '2026-03-08 02:30:00.045' }));
  `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2026-03-08 02:30:00.045');
});
