if (process.env.VITEST) {
  const [
    { EditorView },
    { mount },
    { describe, expect, it },
    { default: PayloadEditor },
  ] = await Promise.all([
    import('@codemirror/view'),
    import('@vue/test-utils'),
    import('vitest'),
    import('../../src/layouts/PayloadEditor.vue'),
  ]);

  function replaceDocument(wrapper, value) {
    const editor = EditorView.findFromDOM(wrapper.get('.cm-editor').element);
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: value,
      },
    });
  }

  describe('PayloadEditor modes', () => {
    it('runs with deterministic browser measurement APIs', () => {
      expect(globalThis.ResizeObserver).toEqual(expect.any(Function));
      expect(globalThis.Range.prototype.getClientRects).toEqual(expect.any(Function));
    });

    it('keeps arbitrary Text payloads valid while editing', () => {
      const wrapper = mount(PayloadEditor, {
        props: { mode: 'text', modelValue: 'plain text {' },
      });

      expect(wrapper.classes()).toContain('payload-editor--text');
      expect(wrapper.emitted('change-valid').at(-1)).toEqual([true]);

      replaceDocument(wrapper, 'still text }');

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['still text }']);
      expect(wrapper.emitted('change-valid').at(-1)).toEqual([true]);
      wrapper.unmount();
    });

    it('keeps HEX payloads valid while editing', () => {
      const wrapper = mount(PayloadEditor, {
        props: { mode: 'hex', modelValue: 'DE AD BE EF' },
      });

      expect(wrapper.classes()).toContain('payload-editor--hex');
      expect(wrapper.emitted('change-valid').at(-1)).toEqual([true]);

      replaceDocument(wrapper, 'GG');

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['GG']);
      expect(wrapper.emitted('change-valid').at(-1)).toEqual([true]);
      wrapper.unmount();
    });

    it('reports JSON validity as the document changes', () => {
      const wrapper = mount(PayloadEditor, {
        props: { mode: 'json', modelValue: '{"ok":true}' },
      });

      expect(wrapper.classes()).toContain('payload-editor--json');
      expect(wrapper.emitted('change-valid').at(-1)).toEqual([true]);

      replaceDocument(wrapper, '{"ok":');

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['{"ok":']);
      expect(wrapper.emitted('change-valid').at(-1)).toEqual([false]);
      wrapper.unmount();
    });

    it('places JSON fold controls before line numbers', () => {
      const wrapper = mount(PayloadEditor, {
        props: { mode: 'json', modelValue: '{\n  "value": 42\n}' },
      });

      const gutters = wrapper.findAll('.cm-gutters .cm-gutter');
      expect(gutters[0].classes()).toContain('cm-foldGutter');
      expect(gutters[1].classes()).toContain('cm-lineNumbers');
      wrapper.unmount();
    });
  });
}
