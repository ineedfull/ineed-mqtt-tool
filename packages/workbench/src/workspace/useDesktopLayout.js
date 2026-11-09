import { computed, onBeforeUnmount, ref, watch } from 'vue';

// Only presentation preferences live here; protocol settings stay in the runtime store.
export function useDesktopLayout(product) {
  const key = `ineed.${product}.desktop-layout.v1`;
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(key) || '{}') || {}; } catch { /* Storage may be unavailable. */ }
  const density = ref(saved.density === 'compact' ? 'compact' : 'comfortable');
  const sidebarWidth = ref(clamp(saved.sidebarWidth, 240, 210, 380));
  const sidebarOpen = ref(typeof saved.sidebarOpen === 'boolean' ? saved.sidebarOpen : !(globalThis.matchMedia?.('(max-width: 760px)').matches ?? false));
  const preferredSubscriptionWidth = ref(clamp(saved.subscriptionWidth, 260, 220, 420));
  const viewportWidth = ref(window.innerWidth);
  const subscriptionMaxWidth = computed(() => Math.max(220, Math.min(420, viewportWidth.value - (sidebarOpen.value ? sidebarWidth.value : 58) - 400)));
  const subscriptionWidth = computed(() => Math.min(preferredSubscriptionWidth.value, subscriptionMaxWidth.value));
  const composerHeight = ref(clamp(saved.composerHeight, 220, 180, 500));
  const themePreference = ref(['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'system');
  watch([density, sidebarWidth, sidebarOpen, preferredSubscriptionWidth, composerHeight, themePreference], () => {
    try {
      window.localStorage.setItem(key, JSON.stringify({ density: density.value, sidebarWidth: sidebarWidth.value,
        sidebarOpen: sidebarOpen.value, subscriptionWidth: preferredSubscriptionWidth.value, composerHeight: composerHeight.value, theme: themePreference.value }));
    } catch { /* The current window remains usable without storage. */ }
  });
  function resizeSidebar(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    window.addEventListener('pointermove', moveSidebar);
    window.addEventListener('pointerup', stopResize, { once: true });
    window.addEventListener('pointercancel', stopResize, { once: true });
  }
  function moveSidebar(event) { sidebarWidth.value = clamp(event.clientX, 240, 210, 380); }
  function stopResize() {
    window.removeEventListener('pointermove', moveSidebar);
    window.removeEventListener('pointermove', moveSubscriptions);
    window.removeEventListener('pointerup', stopResize);
    window.removeEventListener('pointercancel', stopResize);
  }
  let subscriptionDragStart;
  function resizeSubscriptions(event) {
    if (event.button !== 0) return;
    stopResize();
    event.preventDefault();
    subscriptionDragStart = { x: event.clientX, width: subscriptionWidth.value };
    window.addEventListener('pointermove', moveSubscriptions);
    window.addEventListener('pointerup', stopResize, { once: true });
    window.addEventListener('pointercancel', stopResize, { once: true });
  }
  function moveSubscriptions(event) {
    preferredSubscriptionWidth.value = clamp(subscriptionDragStart.width + event.clientX - subscriptionDragStart.x, 260, 220, subscriptionMaxWidth.value);
  }
  function resizeSubscriptionsWithKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = event.key === 'Home' ? 260 : event.key === 'End' ? subscriptionMaxWidth.value
      : subscriptionWidth.value + (event.key === 'ArrowRight' ? 10 : -10);
    preferredSubscriptionWidth.value = clamp(width, 260, 220, subscriptionMaxWidth.value);
  }
  function updateViewport() { viewportWidth.value = window.innerWidth; }
  window.addEventListener('resize', updateViewport);
  function resizeSidebarWithKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    sidebarWidth.value = event.key === 'Home' ? 240 : clamp(sidebarWidth.value + (event.key === 'ArrowRight' ? 10 : -10), 240, 210, 380);
  }
  function toggleDensity() { density.value = density.value === 'compact' ? 'comfortable' : 'compact'; }
  onBeforeUnmount(() => { stopResize(); window.removeEventListener('resize', updateViewport); });
  return { density, sidebarWidth, sidebarOpen, composerHeight, themePreference, resizeSidebar, resizeSidebarWithKeys,
    subscriptionWidth, subscriptionMaxWidth, resizeSubscriptions, resizeSubscriptionsWithKeys, toggleDensity };
}

function clamp(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
