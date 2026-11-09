export async function copyText(value, clipboard) {
  try {
    if (typeof clipboard?.writeText !== 'function') {
      throw new Error('Clipboard unavailable');
    }
    await clipboard.writeText(String(value ?? ''));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Copy failed' };
  }
}
