<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRuntimeAdapter } from '../runtimeContext.js';
import { copyText as writeClipboardText } from '../workspace/clipboard.js';
import { formatHistoryTime } from '../workspace/historyTime.js';
import { formatStoredHistoryPayload, normalizeHistoryFormat } from '../workspace/historyPayload.js';
import { createRuntimeFacade } from '../workspace/runtimeFacade.js';
import { defaultSettings, mergeSettings } from '../workspace/settingsModel.js';

function hasUndatedTime(row) {
  return /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(formatHistoryTime(row));
}

const runtimeFacade = createRuntimeFacade(useRuntimeAdapter());
const params = new URLSearchParams(window.location.search);
const kind = ref(params.get('history') === 'logs' ? 'logs' : 'messages');
const connId = ref(params.get('connId') || '');
const connections = ref([]);
const rows = ref([]);
const selected = ref(null);
const keyword = ref('');
const topic = ref('');
const direction = ref('');
const level = ref('');
const page = ref(1);
const pageSize = ref(100);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const mutating = ref(false);
const copyHint = ref('');
const settings = ref({ ...defaultSettings });
const dbApi = runtimeFacade.db;
let requestGeneration = 0;
let settingsGeneration = 0;
let disposed = false;
let copyHintTimer = null;

const title = computed(() => kind.value === 'logs' ? '历史日志' : '历史消息');
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const busy = computed(() => loading.value || mutating.value);

async function refreshDisplaySettings() {
  const generation = ++settingsGeneration;
  try {
    const saved = await dbApi.getAllSettings();
    if (!disposed && generation === settingsGeneration) settings.value = mergeSettings(saved);
  } catch {
    // Keep history usable with the previous/default display settings if unavailable.
  }
}

function filterPayload() {
  return {
    connId: connId.value,
    keyword: keyword.value.trim(),
    topic: topic.value.trim(),
    direction: direction.value,
    level: level.value,
    page: page.value,
    pageSize: pageSize.value,
  };
}

async function loadRows() {
  const generation = ++requestGeneration;
  const requestKind = kind.value;
  const filters = filterPayload();
  loading.value = true;
  error.value = '';

  try {
    const result = requestKind === 'logs'
      ? await dbApi.queryHistoryLogs(filters)
      : await dbApi.queryHistoryMessages(filters);
    if (disposed || generation !== requestGeneration) return;

    rows.value = result?.rows || [];
    total.value = Number(result?.total || 0);
    selected.value = rows.value[0] || null;
  } catch (cause) {
    if (!disposed && generation === requestGeneration) {
      error.value = errorMessage(cause, '历史记录加载失败');
    }
  } finally {
    if (!disposed && generation === requestGeneration) {
      loading.value = false;
    }
  }
}

async function initialize() {
  const generation = ++requestGeneration;
  loading.value = true;
  error.value = '';

  try {
    const result = await dbApi.getConnections();
    if (disposed || generation !== requestGeneration) return;
    connections.value = result || [];
    await loadRows();
  } catch (cause) {
    if (!disposed && generation === requestGeneration) {
      error.value = errorMessage(cause, '连接列表加载失败');
      loading.value = false;
    }
  }
}

function errorMessage(cause, fallback) {
  const message = typeof cause?.message === 'string' ? cause.message.trim() : '';
  return message || fallback;
}

function search() {
  page.value = 1;
  void loadRows();
}

function onPageSizeChange() {
  page.value = 1;
  void loadRows();
}

function retry() {
  void initialize();
}

async function copyText(value, label) {
  if (copyHintTimer !== null) {
    clearTimeout(copyHintTimer);
    copyHintTimer = null;
  }
  const result = await writeClipboardText(value, runtimeFacade.clipboard);
  if (disposed) return;
  copyHint.value = result.ok ? '已复制 ' + label : '复制失败';
  copyHintTimer = setTimeout(() => {
    copyHint.value = '';
    copyHintTimer = null;
  }, 1400);
}

async function deleteSelected() {
  if (!selected.value || mutating.value) return;
  if (!window.confirm('确认删除这条历史记录吗？')) return;
  const selectedId = selected.value.id;
  const selectedKind = kind.value;
  requestGeneration += 1;
  loading.value = false;
  mutating.value = true;
  error.value = '';

  try {
    if (selectedKind === 'logs') await dbApi.deleteHistoryLog(selectedId);
    else await dbApi.deleteHistoryMessage(selectedId);
    await loadRows();
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause, '历史记录删除失败');
  } finally {
    if (!disposed) mutating.value = false;
  }
}

async function clearCurrentHistory() {
  if (mutating.value) return;
  if (!window.confirm('确认清空当前过滤条件下的历史记录吗？')) return;
  const selectedKind = kind.value;
  const filters = filterPayload();
  requestGeneration += 1;
  loading.value = false;
  mutating.value = true;
  error.value = '';

  try {
    if (selectedKind === 'logs') await dbApi.clearHistoryLogs(filters);
    else await dbApi.clearHistoryMessages(filters);
    await loadRows();
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause, '历史记录清空失败');
  } finally {
    if (!disposed) mutating.value = false;
  }
}

function rowText(row) {
  if (!row) return '';
  if (kind.value === 'logs') return '[' + formatHistoryTime(row) + '] ' + (row.level || '').toUpperCase() + ' ' + (row.msg || '');
  return '[' + formatHistoryTime(row) + '] ' + messageAttributes(row).map(item => item.label).join(' ') + ' ' + (row.topic || '') + '\n' + formatStoredHistoryPayload(row);
}

function messageAttributes(row) {
  const format = normalizeHistoryFormat(row?.format);
  return [
    { label: row?.direction === 'out' ? '发送' : '接收', className: 'history-attr--direction' },
    ...(Number(row?.retained) ? [{ label: 'R', className: 'history-attr--retained' }] : []),
    { label: format.toUpperCase(), className: `history-attr--${format}` },
    { label: `QoS${Number(row?.qos) || 0}`, className: 'history-attr--qos' },
  ];
}

function gotoPage(next) {
  page.value = Math.min(totalPages.value, Math.max(1, next));
  void loadRows();
}

onMounted(() => {
  void initialize();
  void refreshDisplaySettings();
  window.addEventListener('focus', refreshDisplaySettings);
});

onUnmounted(() => {
  disposed = true;
  requestGeneration += 1;
  settingsGeneration += 1;
  window.removeEventListener('focus', refreshDisplaySettings);
  if (copyHintTimer !== null) {
    clearTimeout(copyHintTimer);
    copyHintTimer = null;
  }
});
</script>

<template>
  <div class="history-page" :class="{ 'large-font': settings.largeFont }">
    <header class="history-header">
      <div>
        <h1>{{ title }}</h1>
      </div>
      <div class="history-header__actions">
        <span v-if="copyHint" class="copy-toast">{{ copyHint }}</span>
        <button class="history-clear modal__btn modal__btn--danger" :disabled="busy" @click="clearCurrentHistory">清空历史</button>
      </div>
    </header>

    <section class="history-filters">
      <select v-model="connId" class="history-filters__conn" :disabled="busy">
        <option value="">全部连接</option>
        <option v-for="conn in connections" :key="conn.id" :value="conn.id">{{ conn.name || conn.id }}</option>
      </select>
      <input v-model="keyword" placeholder="搜索内容" :disabled="busy" @keyup.enter="search">
      <input v-if="kind === 'messages'" v-model="topic" placeholder="Topic" :disabled="busy" @keyup.enter="search">
      <select v-if="kind === 'messages'" v-model="direction" :disabled="busy">
        <option value="">全部方向</option>
        <option value="in">接收</option>
        <option value="out">发送</option>
      </select>
      <select v-if="kind === 'logs'" v-model="level" :disabled="busy">
        <option value="">全部级别</option>
        <option value="debug">DEBUG</option>
        <option value="info">INFO</option>
        <option value="warn">WARN</option>
        <option value="err">ERR</option>
        <option value="pub">PUB</option>
      </select>
      <button class="history-search modal__btn modal__btn--primary" :disabled="busy" @click="search">{{ loading ? '查询中' : '查询' }}</button>
    </section>

    <div class="history-state">
      <div v-if="error" class="history-error" role="alert">
        <span>{{ error }}</span>
        <button class="history-retry modal__btn" :disabled="busy" @click="retry">重试</button>
      </div>
      <div v-else-if="loading" class="history-loading" role="status">正在加载历史记录...</div>
    </div>

    <main class="history-body">
      <section class="history-list">
        <div :class="['history-list__head', { 'history-row--messages': kind === 'messages' }]">
          <span>时间</span>
          <span>{{ kind === 'logs' ? '级别' : 'Topic' }}</span>
          <span v-if="kind === 'messages'">标识</span>
          <span>{{ kind === 'logs' ? '内容' : 'Payload' }}</span>
        </div>
        <button
          v-for="row in rows"
          :key="row.id"
          :class="['history-row', { 'history-row--messages': kind === 'messages', 'history-row--active': selected?.id === row.id }]"
          :disabled="busy"
          @click="selected = row"
        >
          <span :title="hasUndatedTime(row) ? '旧记录无日期' : undefined">{{ formatHistoryTime(row) }}</span>
          <span>{{ kind === 'logs' ? row.level : row.topic }}</span>
          <span v-if="kind === 'messages'" class="history-attrs">
            <span v-for="attr in messageAttributes(row)" :key="attr.label" :class="['history-attr', attr.className]">{{ attr.label }}</span>
          </span>
          <span>{{ kind === 'logs' ? row.msg : formatStoredHistoryPayload(row) }}</span>
        </button>
        <div v-if="!loading && !error && rows.length === 0" class="msg-empty">暂无历史记录</div>
      </section>

      <aside class="history-detail">
        <template v-if="selected">
          <div class="history-detail__title">详情</div>
          <div class="history-detail__identity">
            <span>ID {{ selected.id }}</span>
            <span>{{ formatHistoryTime(selected) }}</span>
            <span v-if="hasUndatedTime(selected)">旧记录无日期</span>
          </div>
          <template v-if="kind === 'messages'">
            <div class="history-detail__meta">
              <span v-for="attr in messageAttributes(selected)" :key="attr.label" :class="['history-attr', attr.className]">{{ attr.label }}</span>
            </div>
            <section class="history-detail__section history-detail__topic">
              <div class="history-detail__section-head">
                <span>主题</span>
                <button class="copy-btn" title="复制主题" @click="copyText(selected.topic || '', '主题')">⧉</button>
              </div>
              <div class="history-detail__topic-value">{{ selected.topic }}</div>
            </section>
            <section class="history-detail__section history-detail__payload">
              <div class="history-detail__section-head">
                <span>内容</span>
                <button class="copy-btn" title="复制内容" @click="copyText(formatStoredHistoryPayload(selected), '内容')">⧉</button>
              </div>
              <pre>{{ formatStoredHistoryPayload(selected) }}</pre>
            </section>
          </template>
          <template v-else>
            <pre>{{ rowText(selected) }}</pre>
          </template>
          <div class="history-detail__footer">
            <button v-if="kind === 'logs'" class="modal__btn modal__btn--primary" @click="copyText(rowText(selected), '日志')">复制内容</button>
            <button v-else class="modal__btn modal__btn--primary" @click="copyText(rowText(selected), '消息')">复制完整消息</button>
            <button class="history-delete modal__btn modal__btn--danger" :disabled="busy" @click="deleteSelected">删除记录</button>
          </div>
        </template>
      </aside>
    </main>

    <footer class="history-pager">
      <span class="history-pager__total">共 {{ total }} 条</span>
      <select v-model.number="pageSize" :disabled="busy" @change="onPageSizeChange">
        <option :value="50">50 / 页</option>
        <option :value="100">100 / 页</option>
        <option :value="200">200 / 页</option>
        <option :value="500">500 / 页</option>
      </select>
      <button class="modal__btn" :disabled="busy || page <= 1" @click="gotoPage(page - 1)">上一页</button>
      <span>第 {{ page }} / {{ totalPages }} 页</span>
      <button class="modal__btn" :disabled="busy || page >= totalPages" @click="gotoPage(page + 1)">下一页</button>
    </footer>
  </div>
</template>
