import { matchesTopic } from './topicMatcher.js';

export function filterMessages(messages, { connId, selectedSubscription, topic = '', direction = 'all' }) {
  return messages.filter(message => {
    if (message.connId !== connId) return false;
    if (message.direction === 'in' && selectedSubscription && !matchesTopic(message.topic, selectedSubscription.topic)) return false;
    if (topic && !message.topic.includes(topic)) return false;
    if (direction !== 'all' && message.direction !== direction) return false;
    return true;
  });
}
