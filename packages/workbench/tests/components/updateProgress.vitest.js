import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import UpdateProgress from '../../src/components/UpdateProgress.vue';

describe('update progress', () => {
  it('never offers installation while downloading or verifying', () => {
    for (const phase of ['downloading', 'verifying', 'preparing', 'installing']) {
      const wrapper = mount(UpdateProgress, { props: { state: { phase, transferred: 50, total: 100, percent: 50 } } });
      expect(wrapper.find('.update-restart').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('undefined');
    }
  });
  it('requires a second explicit confirmation to interrupt MQTT and install', async () => {
    const wrapper = mount(UpdateProgress, { props: { state: { phase: 'ready', version: '0.1.1', error: '' } } });
    await wrapper.get('.update-restart').trigger('click');
    expect(wrapper.emitted('install')).toBeUndefined();
    expect(wrapper.text()).toContain('MQTT 连接将断开');
    await wrapper.get('.update-confirm-install').trigger('click');
    expect(wrapper.emitted('install')).toHaveLength(1);
  });
  it('shows errors with verified state and allows the user to retry installation', () => {
    const wrapper = mount(UpdateProgress, { props: { state: { phase: 'ready', error: '保存失败' } } });
    expect(wrapper.get('[role="alert"]').text()).toContain('保存失败');
    expect(wrapper.find('.update-restart').exists()).toBe(true);
  });
});
