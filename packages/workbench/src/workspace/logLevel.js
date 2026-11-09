const levelRank = {
  debug: 10,
  pub: 20,
  info: 20,
  warn: 30,
  err: 40,
  error: 40
};

export function shouldShowLog(level, threshold = 'debug') {
  const current = levelRank[level] ?? levelRank.info;
  const minimum = levelRank[threshold] ?? levelRank.debug;
  return current >= minimum;
}
