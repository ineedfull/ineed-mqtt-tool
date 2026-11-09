import { nextTick, onBeforeUnmount, ref, shallowRef } from 'vue';

export function useSubscriptionMenu() {
  const subscription = shallowRef(null);
  const menu = ref(null);
  const position = ref({});
  let trigger = null;

  function close(restoreFocus = false) {
    subscription.value = null;
    window.removeEventListener('pointerdown', outside);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', dismiss);
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }
  function dismiss() { close(); }
  function reposition() {
    if (!trigger) { close(); return; }
    const box = trigger.getBoundingClientRect();
    const list = trigger.closest('.sub-list')?.getBoundingClientRect();
    if (list?.height > 0 && (box.bottom <= list.top || box.top >= list.bottom)) { close(); return; }
    const height = menu.value?.offsetHeight || 92;
    position.value = { left: `${Math.max(8, Math.min(box.right - 188, window.innerWidth - 196))}px`,
      top: `${Math.max(8, Math.min(box.bottom + 4, window.innerHeight - height - 8))}px` };
  }
  function outside(event) {
    if (!menu.value?.contains(event.target) && !trigger?.contains(event.target)) close();
  }
  async function toggle(sub, event) {
    if (subscription.value?.id === sub.id) { close(true); return; }
    close();
    trigger = event.currentTarget;
    trigger.focus({ preventScroll: true });
    subscription.value = sub;
    reposition();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', dismiss);
    await nextTick();
    if (subscription.value) {
      reposition();
      menu.value?.querySelector('button')?.focus({ preventScroll: true });
    }
  }
  function keydown(event) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.value.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  function run(action) {
    const sub = subscription.value;
    close(true);
    if (sub) action(sub);
  }
  onBeforeUnmount(() => close());
  return { subscription, menu, position, toggle, close, keydown, run };
}
