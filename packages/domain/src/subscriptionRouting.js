import { matchesTopic } from './topicMatcher.js';

const palette = [
  '#0072b2',
  '#e69f00',
  '#009e73',
  '#d55e00',
  '#cc79a7',
  '#56b4e9',
  '#f0e442',
  '#6f42c1',
  '#8b5e3c',
  '#64748b'
];

const legacyPalette = new Set([
  '#2563eb', '#059669', '#dc2626', '#7c3aed', '#d97706',
  '#0891b2', '#be123c', '#4f46e5', '#16a34a', '#c2410c',
  '#0f766e'
]);

export const subscriptionColorPalette = [...palette];

function topicSpecificity(topic = '') {
  const segments = topic.split('/').filter(Boolean);
  const wildcardPenalty = (topic.match(/[#+]/g) || []).length * 20;
  const exactChars = topic.replace(/[#+]/g, '').length;
  return segments.length * 100 + exactChars - wildcardPenalty;
}

function fallbackSubscriptionColor(id = '') {
  const text = String(id || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

function normalizeColor(color) {
  return String(color || '').trim().toLowerCase();
}

function generatedSubscriptionColor(index) {
  const value = (0x1f2937 + ((index + 1) * 0x9e3779)) & 0xffffff;
  return '#' + value.toString(16).padStart(6, '0');
}

function isReadableGeneratedColor(color) {
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
  const average = channels.reduce((sum, value) => sum + value, 0) / channels.length;
  return average >= 55 && average <= 200 && Math.max(...channels) - Math.min(...channels) >= 45;
}

export function assignSubscriptionColor(subscriptions = [], connId) {
  const used = new Set(
    subscriptions
      .filter(sub => sub.connId === connId)
      .map(sub => normalizeColor(sub.color))
      .filter(Boolean)
  );
  const available = palette.find(color => !used.has(color));
  if (available) return available;

  for (let index = 0; index < 0x1000000; index += 1) {
    const candidate = generatedSubscriptionColor(index);
    if (!used.has(candidate) && isReadableGeneratedColor(candidate)) return candidate;
  }

  throw new Error('No unique subscription color is available.');
}

export function shouldReassignSubscriptionColor(subscriptions = [], sub = {}) {
  const color = normalizeColor(sub.color);
  if (!color || legacyPalette.has(color)) return true;
  return subscriptions.some(existing =>
    existing.connId === sub.connId &&
    existing.id !== sub.id &&
    normalizeColor(existing.color) === color
  );
}

export function getSubscriptionColor(sub = '') {
  if (typeof sub === 'object' && sub?.color) return sub.color;
  const id = typeof sub === 'object' ? (sub?.id || sub?.topic) : sub;
  return fallbackSubscriptionColor(id);
}

export function matchMessageSubscriptions(subscriptions = [], connId, topic) {
  return subscriptions
    .filter(sub => sub.connId === connId && matchesTopic(topic, sub.topic))
    .sort((a, b) => topicSpecificity(b.topic) - topicSpecificity(a.topic));
}

export function selectPrimarySubscription(subscriptions = [], connId, topic) {
  return matchMessageSubscriptions(subscriptions, connId, topic)[0] || null;
}

export function incrementMatchedSubscriptionCounts(matchedSubscriptions = []) {
  const counted = new Set();
  for (const subscription of matchedSubscriptions) {
    if (!subscription?.id || counted.has(subscription.id)) continue;
    counted.add(subscription.id);
    subscription.messageCount = (subscription.messageCount || 0) + 1;
  }
}

export function resetSubscriptionMessageCounts(subscriptions = [], connId) {
  subscriptions
    .filter(subscription => subscription.connId === connId)
    .forEach(subscription => { subscription.messageCount = 0; });
}

export function buildSubscriptionWarning(subscriptions = [], sub) {
  const sameConn = subscriptions.filter(item => item.connId === sub.connId && item.status !== 'inactive');
  const duplicate = sameConn.find(item => item.topic === sub.topic && item.id !== sub.id);
  if (duplicate) {
    return { type: 'duplicate', message: '该订阅已存在，将重复监听。', subscriptions: [duplicate] };
  }

  const covering = sameConn.filter(item => item.id !== sub.id && matchesTopic(sub.topic, item.topic));
  if (covering.length) {
    return { type: 'covered', message: '该订阅已被 ' + covering[0].topic + ' 覆盖，消息可能同时命中多个订阅。', subscriptions: covering };
  }

  const covered = sameConn.filter(item => item.id !== sub.id && matchesTopic(item.topic, sub.topic));
  if (covered.length) {
    return { type: 'covers', message: '新订阅将覆盖已有 ' + covered.length + ' 个订阅。', subscriptions: covered };
  }

  return null;
}
