import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectionStatusLog, sourceLabel } from '../src/connectionDiagnostics.js';

test('connection diagnostics use conservative source labels', () => {
  assert.equal(sourceLabel('broker'), 'Broker');
  assert.equal(sourceLabel('network'), '网络或远端');
  assert.equal(sourceLabel('client'), '客户端');
  assert.equal(sourceLabel('unknown'), '未知');
});

test('one outage cycle produces one primary reconnect warning', () => {
  const event = { status: 'reconnecting', source: 'network', code: 'CONNECTION_RESET', reason: 'socket hang up', attempt: 1 };
  assert.deepEqual(buildConnectionStatusLog(event, { previousStatus: 'connected' }), {
    level: 'warn',
    message: '连接中断 [网络或远端] CONNECTION_RESET: socket hang up，正在自动重连',
  });
  assert.equal(buildConnectionStatusLog(event, { previousStatus: 'reconnecting' }), null);
});

test('connection diagnostics describe cancellation and reconnect recovery', () => {
  assert.equal(buildConnectionStatusLog({ status: 'disconnected', source: 'user' }, { previousStatus: 'connecting' }).message, '用户终止了连接');
  assert.equal(buildConnectionStatusLog({ status: 'disconnected', source: 'user', attempt: 6, disconnectedAt: 1000 }, { previousStatus: 'reconnecting', now: 19420 }).message, '用户停止自动重连，已尝试 6 次，持续 18.420 秒');
  assert.equal(buildConnectionStatusLog({ status: 'connected', reconnected: true, attempt: 3, disconnectedAt: 1000 }, { now: 3341, subscriptionCount: 8 }).message, '自动重连成功，断线持续 2.341 秒，共尝试 3 次，正在恢复 8 个订阅');
});

test('initial connection errors retain classified details', () => {
  assert.deepEqual(buildConnectionStatusLog({ status: 'error', source: 'broker', code: 'AUTH_FAILED', reason: 'Not authorized' }), {
    level: 'err',
    message: '首次连接失败 [Broker] AUTH_FAILED: Not authorized',
  });
});
