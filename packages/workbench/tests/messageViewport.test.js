import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageLayout, selectMessageViewport } from '../src/workspace/messageViewport.js';
const items = Array.from({ length: 50000 }, (_, id) => ({ id }));

test('a large retained stream renders only the viewport and keeps the newest message accessible', () => {
  const layout = buildMessageLayout(items, new Map(), { estimate: 160, gap: 16 });
  const viewport = selectMessageViewport(layout, { following: true, height: 600, overscan: 300 });
  assert.ok(viewport.rows.length < 20);
  assert.equal(viewport.rows.at(-1).item.id, 49999);
  assert.equal(items.length, 50000);
  assert.ok(viewport.beforeHeight > 0);
  assert.equal(viewport.afterHeight, 0);
});

test('measured row heights and spacers preserve scroll extent at the beginning, middle and end', () => {
  const records = Array.from({ length: 100 }, (_, id) => ({ id }));
  const heights = new Map(records.map(item => [item.id, item.id % 3 === 0 ? 400 : 100]));
  const layout = buildMessageLayout(records, heights, { estimate: 160, gap: 16 });
  for (const scrollTop of [0, 3000, layout.totalHeight]) {
    const viewport = selectMessageViewport(layout, { scrollTop, height: 600, overscan: 0 });
    const rowsHeight = viewport.rows.reduce((sum, row) => sum + heights.get(row.item.id), 0);
    const children = viewport.rows.length + Number(viewport.beforeHeight > 0) + Number(viewport.afterHeight > 0);
    assert.equal(viewport.beforeHeight + rowsHeight + viewport.afterHeight + Math.max(0, children - 1) * 16, layout.totalHeight);
  }
});

test('every retained message can be reached when manually scrolling', () => {
  const records = items.slice(0, 1000);
  const layout = buildMessageLayout(records, new Map(), { estimate: 160, gap: 16 });
  for (let index = 0; index < records.length; index++) {
    const viewport = selectMessageViewport(layout, { scrollTop: layout.offsets[index], height: 600, overscan: 0 });
    assert.ok(viewport.rows.some(row => row.item.id === index), `message ${index} must be reachable`);
  }
});

test('empty and short streams preserve the complete existing list', () => {
  for (const records of [[], items.slice(0, 3)]) {
    const viewport = selectMessageViewport(buildMessageLayout(records, new Map()), { following: true, height: 1 });
    assert.deepEqual(viewport.rows.map(row => row.item), records);
    assert.equal(viewport.beforeHeight + viewport.afterHeight, 0);
  }
});
