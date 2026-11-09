import { matchesTopic } from './topicMatcher.js';

export function findCoveringSubscription(subscriptions = [], sub) {
  return subscriptions.find(existing => (
    existing.id !== sub.id &&
    existing.connId === sub.connId &&
    existing.status === 'active' &&
    matchesTopic(sub.topic, existing.topic)
  )) || null;
}
