export function matchesTopic(topic, filter) {
  const topicLevels = String(topic || '').split('/');
  const filterLevels = String(filter || '').split('/');

  for (let index = 0; index < filterLevels.length; index += 1) {
    const filterLevel = filterLevels[index];
    if (filterLevel === '#') return index === filterLevels.length - 1;
    if (index >= topicLevels.length) return false;
    if (filterLevel !== '+' && filterLevel !== topicLevels[index]) return false;
  }

  return topicLevels.length === filterLevels.length;
}
