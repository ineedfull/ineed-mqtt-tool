export function getPayloadValidity(value, mode) {
  if (mode !== 'json') return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function formatPayloadOnBlur(value, mode) {
  if (mode !== 'json') return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
