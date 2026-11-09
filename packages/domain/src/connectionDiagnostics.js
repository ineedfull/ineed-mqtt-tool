const SOURCE_LABELS = {
  broker: 'Broker',
  network: '网络或远端',
  client: '客户端',
  user: '用户',
  unknown: '未知',
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS.unknown;
}

function formatDuration(milliseconds) {
  return `${(Math.max(0, Number(milliseconds) || 0) / 1000).toFixed(3)} 秒`;
}

function diagnosticText(event) {
  const code = event.code || 'UNKNOWN_DISCONNECT';
  return `${code}${event.reason ? `: ${event.reason}` : ''}`;
}

export function buildConnectionStatusLog(event = {}, context = {}) {
  const previousStatus = context.previousStatus || '';
  const now = Number(context.now) || Date.now();
  const startedAt = Number(event.disconnectedAt) || now;
  const duration = formatDuration(now - startedAt);
  const attempt = Math.max(0, Number(event.attempt) || 0);

  if (event.status === 'reconnecting') {
    if (previousStatus === 'reconnecting') return null;
    return {
      level: 'warn',
      message: `连接中断 [${sourceLabel(event.source)}] ${diagnosticText(event)}，正在自动重连`,
    };
  }
  if (event.status === 'connected' && event.reconnected) {
    return {
      level: 'info',
      message: `自动重连成功，断线持续 ${duration}，共尝试 ${attempt} 次，正在恢复 ${Number(context.subscriptionCount) || 0} 个订阅`,
    };
  }
  if (event.status === 'disconnected' && event.source === 'user') {
    if (previousStatus === 'reconnecting') {
      return { level: 'info', message: `用户停止自动重连，已尝试 ${attempt} 次，持续 ${duration}` };
    }
    return { level: 'info', message: previousStatus === 'connecting' ? '用户终止了连接' : '用户主动断开连接' };
  }
  if (event.status === 'error') {
    const prefix = ['connected', 'reconnecting'].includes(previousStatus) ? '连接异常' : '首次连接失败';
    return {
      level: 'err',
      message: `${prefix} [${sourceLabel(event.source)}] ${diagnosticText(event)}`,
    };
  }
  return null;
}
