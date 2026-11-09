import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowLog } from '../src/workspace/logLevel.js';

test('shouldShowLog filters lower level logs by selected threshold', () => {
  assert.equal(shouldShowLog('debug', 'info'), false);
  assert.equal(shouldShowLog('info', 'info'), true);
  assert.equal(shouldShowLog('warn', 'info'), true);
  assert.equal(shouldShowLog('err', 'warn'), true);
  assert.equal(shouldShowLog('pub', 'info'), true);
});
