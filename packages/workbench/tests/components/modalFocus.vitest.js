/* global document, KeyboardEvent */
import { afterEach, expect, test, vi } from 'vitest';
import { modalDirective } from '../../src/workspace/modalDirective.js';
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ''; });

test('modal Tab skips disabled fieldsets and hidden ancestors, handles busy controls, and restores focus', async () => {
  document.body.innerHTML = '<button id="trigger">Open</button><section id="dialog"><button id="first">First</button><fieldset disabled><input id="disabled"></fieldset><div style="display:none"><button>Hidden</button></div><button disabled tabindex="0">Busy</button><input type="hidden"><button tabindex="-1">Skipped</button><input id="last"></section>';
  const trigger = document.querySelector('#trigger');
  const root = document.querySelector('#dialog');
  const first = document.querySelector('#first');
  const last = document.querySelector('#last');
  const close = vi.fn();
  trigger.focus();
  modalDirective.mounted(root, { value: { close } });
    await Promise.resolve();
    dispose = () => modalDirective.unmounted(root);
  expect(document.activeElement).toBe(first);
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(last);
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(first);
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(last);
  first.disabled = true;
  last.disabled = true;
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(root);
  dispose();
  dispose = () => {};
  expect(document.activeElement).toBe(trigger);
});
