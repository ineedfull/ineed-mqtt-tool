import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { buildMessageLayout, selectMessageViewport } from './messageViewport.js';

export function useMessageViewport({ items, element, following, context, refreshFollow }) {
  const heights = new Map();
  const elements = new Map();
  const revision = ref(0);
  const scrollTop = ref(0);
  const viewportHeight = ref(600);
  const gap = ref(16);
  let width = 0;
  let paddingTop = 16;
  let observer = null;
  let disposed = false;
  let measurementFrame = null;
  const layout = computed(() => {
    revision.value;
    return buildMessageLayout(items.value, heights, { gap: gap.value });
  });
  const viewport = computed(() => selectMessageViewport(layout.value, {
    scrollTop: Math.max(0, scrollTop.value - paddingTop), height: viewportHeight.value, following: following.value,
  }));

  function measure() {
    const container = element.value;
    if (disposed || !container?.clientHeight) return;
    const style = getComputedStyle(container);
    paddingTop = Number.parseFloat(style.paddingTop) || 0;
    gap.value = Number.parseFloat(style.rowGap) || 0;
    viewportHeight.value = Math.max(1, container.clientHeight - paddingTop - (Number.parseFloat(style.paddingBottom) || 0));
    if (width !== container.clientWidth) { width = container.clientWidth; heights.clear(); }
    let changed = false;
    for (const [id, el] of elements) {
      const height = el.getBoundingClientRect().height;
      if (height > 0 && Math.abs((heights.get(id) || 0) - height) > 0.5) {
        heights.set(id, height);
        changed = true;
      }
    }
    if (changed) revision.value++;
    if (following.value) void refreshFollow();
  }

  function scheduleMeasure() {
    if (disposed || measurementFrame !== null) return;
    // Read and update in the next frame, outside ResizeObserver delivery.
    // Mutating spacer heights during delivery creates a WebKit/Chromium loop.
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = null;
      measure();
    });
  }

  function setRowElement(id, el) {
    const previous = elements.get(id);
    if (previous === el) return;
    if (previous) observer?.unobserve(previous);
    if (el) { elements.set(id, el); observer?.observe(el); }
    else elements.delete(id);
  }
  function onScroll() { scrollTop.value = element.value?.scrollTop || 0; }

  watch(items, (current, previous = []) => {
    let anchor = null;
    if (!following.value && previous.length) {
      const oldLayout = buildMessageLayout(previous, heights, { gap: gap.value });
      const oldViewport = selectMessageViewport(oldLayout, { scrollTop: Math.max(0, scrollTop.value - paddingTop), height: 1, overscan: 0 });
      const row = oldViewport.rows[0];
      if (row) anchor = { id: row.item.id, inset: scrollTop.value - oldLayout.offsets[oldViewport.start] };
    }
    const retained = new Set(current.map(item => item.id));
    for (const id of heights.keys()) if (!retained.has(id)) heights.delete(id);
    if (anchor) void nextTick(() => {
      if (disposed || following.value || !element.value) return;
      const index = current.findIndex(item => item.id === anchor.id);
      element.value.scrollTop = index < 0 ? 0 : layout.value.offsets[index] + anchor.inset;
      onScroll();
    });
  });
  watch(context, () => { heights.clear(); revision.value++; scheduleMeasure(); });
  watch(element, (current, previous) => {
    if (previous) observer?.unobserve(previous);
    if (current) { observer?.observe(current); scheduleMeasure(); }
  });
  onMounted(() => {
    observer = new ResizeObserver(scheduleMeasure);
    if (element.value) observer.observe(element.value);
    for (const el of elements.values()) observer.observe(el);
    scheduleMeasure();
  });
  onBeforeUnmount(() => {
    disposed = true;
    if (measurementFrame !== null) cancelAnimationFrame(measurementFrame);
    observer?.disconnect(); elements.clear(); heights.clear();
  });
  return {
    rows: computed(() => viewport.value.rows.map(row => row.item)),
    beforeHeight: computed(() => viewport.value.beforeHeight), afterHeight: computed(() => viewport.value.afterHeight),
    setRowElement, onScroll,
  };
}
