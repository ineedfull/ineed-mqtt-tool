/* global document */
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useStreamFollow } from '../../src/workspace/useStreamFollow.js';
import { useDesktopLayout } from '../../src/workspace/useDesktopLayout.js';
const wrappers = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks(); globalThis.window.localStorage.clear(); });

describe('desktop stream navigation', () => {
  test('hidden streams avoid layout reads and recover following without losing incoming state', async () => {
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const ids = ref(['a']);
    let follow;
    const wrapper = mount(defineComponent({ setup() {
      const element = ref(null);
      follow = useStreamFollow({ element, keys: () => ids.value, enabled: () => true });
      return () => h('div', { ref: element }, ids.value.join(','));
    } }));
    wrappers.push(wrapper);
    let reads = 0;
    Object.defineProperty(wrapper.element, 'scrollHeight', { get() { reads++; return 1000; } });
    ids.value = ['a', 'b'];
    await flushPromises();
    expect(reads).toBe(0);
    expect(wrapper.text()).toBe('a,b');
    expect(follow.following.value).toBe(true);
    expect(follow.visible.value).toBe(false);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(follow.visible.value).toBe(true);
    expect(wrapper.element.scrollTop).toBe(1000);
    expect(reads).toBe(1);

    follow.pause();
    wrapper.element.scrollTop = 400;
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    ids.value = ['b', 'c'];
    await flushPromises();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(follow.following.value).toBe(false);
    expect(follow.unread.value).toBe(1);
    expect(wrapper.element.scrollTop).toBe(400);
    expect(reads).toBe(1);

    wrapper.unmount();
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(follow.visible.value).toBe(true);
    expect(reads).toBe(1);
  });

  test('upward navigation pauses only the viewport, counts additions at the retention limit, and resumes', async () => {
    const ids = ref(['a', 'b']);
    const enabled = ref(true);
    const context = ref('connection-a');
    let follow;
    const wrapper = mount(defineComponent({ setup() {
      const element = ref(null);
      follow = useStreamFollow({ element, keys: () => ids.value, enabled: () => enabled.value, context: () => context.value });
      return () => h('div', { ref: element, onWheel: follow.onWheel, onScroll: follow.onScroll, onKeydown: follow.onKeydown });
    } }));
    wrappers.push(wrapper);
    Object.defineProperties(wrapper.element, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200 } });
    await flushPromises();
    expect(wrapper.element.scrollTop).toBe(1000);
    await wrapper.trigger('wheel', { deltaY: -40 });
    wrapper.element.scrollTop = 400;
    ids.value = ['b', 'c'];
    await flushPromises();
    expect(follow.following.value).toBe(false);
    expect(follow.unread.value).toBe(1);
    expect(wrapper.element.scrollTop).toBe(400);
    ids.value = [...ids.value];
    await flushPromises();
    expect(follow.unread.value).toBe(1);
    follow.resume();
    await flushPromises();
    expect(wrapper.element.scrollTop).toBe(1000);
    expect(follow.unread.value).toBe(0);
    await wrapper.trigger('keydown', { key: 'PageUp' });
    expect(follow.following.value).toBe(false);
    enabled.value = false;
    context.value = 'connection-b';
    ids.value = ['other'];
    await flushPromises();
    expect(follow.following.value).toBe(false);
    expect(follow.unread.value).toBe(0);
    follow.resume();
    await flushPromises();
    expect(enabled.value).toBe(false);
  });

  test('dragging the scrollbar upward pauses following without needing a wheel event', async () => {
    let follow;
    const wrapper = mount(defineComponent({ setup() {
      const element = ref(null);
      follow = useStreamFollow({ element, keys: () => ['one'], enabled: () => true });
      return () => h('div', { ref: element, onScroll: follow.onScroll });
    } }));
    wrappers.push(wrapper);
    Object.defineProperties(wrapper.element, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    await flushPromises();
    wrapper.element.scrollTop = 200;
    await wrapper.trigger('scroll');
    expect(follow.following.value).toBe(false);
  });

  test('visual preferences survive a remount, while corrupt storage falls back safely', async () => {
    globalThis.window.localStorage.setItem('ineed.test.desktop-layout.v1', '{broken');
    let layout;
    const component = defineComponent({ setup() { layout = useDesktopLayout('test'); return () => h('div'); } });
    const wrapper = mount(component);
    expect(layout.sidebarWidth.value).toBe(240);
    layout.resizeSidebarWithKeys({ key: 'ArrowRight', preventDefault() {} });
    layout.toggleDensity();
    layout.composerHeight.value = 260;
    await nextTick();
    wrapper.unmount();
    wrappers.push(mount(component));
    expect(layout.sidebarWidth.value).toBe(250);
    expect(layout.density.value).toBe('compact');
    expect(layout.composerHeight.value).toBe(260);
  });
});
