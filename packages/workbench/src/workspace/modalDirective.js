// Shared modal behavior for the MQTT dialogs. Every close path respects pending work.
const states = new WeakMap();
const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
export const modalDirective = {
  mounted(element, binding) {
    const state = { options: binding.value, previous: document.activeElement };
    const controls = () => [...element.querySelectorAll(selector)].filter(item => {
      if (item.matches(':disabled') || item.tabIndex < 0 || item.closest('[hidden], [inert]')) return false;
      for (let node = item; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    });
    state.keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!state.options.busy) state.options.close();
      } else if (event.key === 'Tab') {
        const items = controls();
        if (!items.length) { event.preventDefault(); element.setAttribute('tabindex', '-1'); element.focus(); return; }
        // WebKit can skip native buttons; move through every available control explicitly.
        event.preventDefault();
        const index = items.indexOf(document.activeElement);
        const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next].focus();
      }
    };
    element.addEventListener('keydown', state.keydown);
    states.set(element, state);
    queueMicrotask(() => {
      if (!element.isConnected) return;
      (element.querySelector('[data-autofocus]') || controls()[0] || element).focus();
    });
  },
  updated(element, binding) { states.get(element).options = binding.value; },
  unmounted(element) {
    const state = states.get(element);
    element.removeEventListener('keydown', state.keydown);
    if (state.previous?.isConnected) state.previous.focus();
    states.delete(element);
  },
};
