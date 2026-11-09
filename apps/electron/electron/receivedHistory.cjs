'use strict';

// Mirror the shared subscription specificity and history formats at the native
// boundary. Commit reception before sending it to a potentially busy WebView.
function specificity(topic) {
  return topic.split('/').filter(Boolean).length * 100
    + topic.replace(/[#+]/g, '').length - (topic.match(/[#+]/g) || []).length * 20;
}
function matches(topic, filter) {
  const levels = topic.split('/'), filters = filter.split('/');
  for (let i = 0; i < filters.length; i++) {
    if (filters[i] === '#') return i === filters.length - 1;
    if (i >= levels.length || (filters[i] !== '+' && filters[i] !== levels[i])) return false;
  }
  return levels.length === filters.length;
}
function saveReceivedHistory(db, messages) {
  const pending = messages.filter(message => message.historyPersisted !== true);
  if (!pending.length) return;
  const settings = db.getAllSettings();
  const byConnection = new Map();
  const rows = pending.map(message => {
    if (!byConnection.has(message.connId)) byConnection.set(message.connId,
      db.getSubscriptions(message.connId).sort((a, b) => specificity(b.topic) - specificity(a.topic)));
    const sub = byConnection.get(message.connId).find(sub => matches(message.topic, sub.topic));
    const chosen = String(sub?.format || settings.payloadFormat || 'text').toLowerCase();
    const format = ['json', 'hex', 'text'].includes(chosen) ? chosen : 'text';
    let payload = message.payloadText ?? Buffer.from(message.payload).toString('utf8');
    if (format === 'hex') payload = Buffer.from(message.payload).toString('hex').toUpperCase();
    if (format === 'json') { try { payload = JSON.stringify(JSON.parse(payload), null, 2); } catch { /* Keep invalid JSON as received. */ } }
    return { connection_id: message.connId, topic: message.topic, payload, format,
      direction: 'in', qos: message.qos, retained: message.retained ? 1 : 0 };
  });
  db.saveMessages(rows);
  // Mark only after the transaction commits. Delivery retries reuse these rows.
  for (const message of pending) message.historyPersisted = true;
}
module.exports = { saveReceivedHistory };
