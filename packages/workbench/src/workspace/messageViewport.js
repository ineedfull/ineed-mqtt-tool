// Retention and filtering belong to the workbench. This model only chooses which
// retained rows need DOM nodes; scroll spacers preserve access to every row.
export function buildMessageLayout(items, heights, { estimate = 180, gap = 16 } = {}) {
  const offsets = [0];
  for (const item of items) offsets.push(offsets.at(-1) + (heights.get(item.id) || estimate) + gap);
  return { items, offsets, gap, totalHeight: Math.max(0, offsets.at(-1) - gap) };
}

function rowAtOffset(offsets, offset) {
  let low = 0, high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function selectMessageViewport(layout, { scrollTop = 0, height = 600, following = false, overscan = 400 } = {}) {
  const { items, offsets, gap, totalHeight } = layout;
  const top = following ? Math.max(0, totalHeight - height) : Math.min(scrollTop, Math.max(0, totalHeight - height));
  let start = 0, end = items.length;
  if (items.length > 20) {
    start = rowAtOffset(offsets, Math.max(0, top - overscan));
    end = start;
    while (end < items.length && offsets[end] < top + height + overscan) end++;
    end = Math.max(start + 1, end);
  }
  return {
    start, end, rows: items.slice(start, end).map((item, index) => ({ item, offset: offsets[start + index] })),
    beforeHeight: start ? Math.max(0, offsets[start] - gap) : 0,
    afterHeight: end < items.length ? Math.max(0, offsets.at(-1) - offsets[end] - gap) : 0,
  };
}
