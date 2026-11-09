<script setup>
import { tags } from '@lezer/highlight';
import { HighlightStyle } from '@codemirror/language';
const payloadHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--payload-key)' },
  { tag: tags.string, color: 'var(--payload-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--payload-value)' },
  { tag: tags.punctuation, color: 'var(--payload-punctuation)' },
]);
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  syntaxHighlighting
} from '@codemirror/language';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { lintGutter, linter, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';

import { getPayloadValidity } from '../workspace/payloadEditorState.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  mode: { type: String, default: 'json' },
  invalid: { type: Boolean, default: false }
});

const searchPhrases = {
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全选',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
};

const emit = defineEmits(['update:modelValue', 'blur', 'change-valid', 'submit']);

const editorRoot = ref(null);
let editorView = null;

function getDoc() {
  return editorView?.state.doc.toString() || '';
}

function emitValidity(value = props.modelValue) {
  emit('change-valid', getPayloadValidity(value, props.mode));
}

function createFoldMarker(open) {
  const marker = document.createElement('span');
  marker.className = `payload-fold-marker payload-fold-marker--${open ? 'open' : 'closed'}`;
  marker.title = open ? 'Fold line' : 'Unfold line';
  return marker;
}

function editorExtensions() {
  const baseExtensions = [
    EditorView.contentAttributes.of({ 'aria-label': '发送内容', 'aria-multiline': 'true' }),
    EditorState.phrases.of(searchPhrases),
    ...(props.mode === 'json' ? [foldGutter({ markerDOM: createFoldMarker })] : []),
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    bracketMatching(),
    search({ top: true }),
    highlightSelectionMatches(),
    syntaxHighlighting(payloadHighlightStyle),
    highlightActiveLine(),
    placeholder(props.mode === 'json' ? '输入 JSON...' : '输入文本...'),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      const value = update.state.doc.toString();
      emit('update:modelValue', value);
      emit('change-valid', getPayloadValidity(value, props.mode));
    }),
    EditorView.domEventHandlers({
      blur: () => {
        emit('blur');
      },
      keydown: event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          emit('submit');
        }
      }
    }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...lintKeymap
    ])
  ];

  if (props.mode === 'json') {
    baseExtensions.push(
      json(),
      lintGutter(),
      linter(jsonParseLinter(), { delay: 250 })
    );
  }

  return baseExtensions;
}

function createEditor() {
  if (!editorRoot.value) return;
  editorView?.destroy();
  editorView = new EditorView({
    parent: editorRoot.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: editorExtensions()
    })
  });
  emitValidity();
}

onMounted(createEditor);
onBeforeUnmount(() => {
  editorView?.destroy();
  editorView = null;
});

watch(() => props.modelValue, value => {
  if (!editorView || value === getDoc()) return;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: value || '' }
  });
  emitValidity(value || '');
});

watch(() => props.mode, createEditor);
</script>

<template>
  <div
    ref="editorRoot"
    :class="['payload-editor', `payload-editor--${mode}`, { 'payload-editor--invalid': invalid }]"
  />
</template>
