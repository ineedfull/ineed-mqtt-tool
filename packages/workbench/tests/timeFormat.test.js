import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as dates from '../src/workspace/timeFormat.js';

test('UI timestamps convert explicit timezones to local time independently of locale and old settings', () => {
  for (const [zone, expected, rollover, leap] of [['UTC', '2026-07-09 06:38:12.045', '2025-12-31 16:00:00.007', '2024-02-29 00:00:00.000'], ['Asia/Shanghai', '2026-07-09 14:38:12.045', '2026-01-01 00:00:00.007', '2024-02-29 08:00:00.000'], ['America/New_York', '2026-07-09 02:38:12.045', '2025-12-31 11:00:00.007', '2024-02-28 19:00:00.000']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { formatTimestamp, formatClockTime } from ${JSON.stringify(new URL('../src/workspace/timeFormat.js', import.meta.url).href)};
      console.log(JSON.stringify([formatTimestamp('2026-07-09T14:38:12.045+08:00'), formatClockTime('2026-07-09T06:38:12.045Z'), formatTimestamp(Date.parse('2026-07-09T06:38:12.045Z'), 'absolute'), formatTimestamp('2026-01-01T00:00:00.007+08:00'), formatTimestamp('2024-02-29T00:00:00Z')]));
    `], { env: { ...process.env, TZ: zone, LANG: 'de_DE.UTF-8' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [expected, expected.split(' ')[1], expected, rollover, leap]);
  }
});

test('UI timestamps keep epoch zero and reject missing, ambiguous or impossible instants', () => {
  assert.notEqual(dates.formatTimestamp(0), '--');
  for (const value of [undefined, null, '', false, {}, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, '0', '2026-07-09', '2026-07-09T14:38:12', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z', 'invalid']) {
    assert.equal(dates.formatTimestamp(value), '--', String(value));
  }
});
