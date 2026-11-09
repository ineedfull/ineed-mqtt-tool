<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import PayloadEditor from './PayloadEditor.vue';
import { APP_VERSION, PRODUCT_NAME, PRODUCT_WEBSITE } from '../product.js';
import '../styles/about.css';
import { ArrowRightLeft, CircleHelp, Copy, FileClock, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, X } from 'lucide-vue-next';
import appIcon from '../assets/ineed-mqtt.svg';
import { modalDirective as vModal } from '../workspace/modalDirective.js';
import { useSubscriptionMenu } from '../workspace/useSubscriptionMenu.js';
import { useDesktopLayout } from '../workspace/useDesktopLayout.js';
import { originalMessageContent } from '../workspace/messageInspector.js';
import { useMessageViewport } from '../workspace/useMessageViewport.js';
import { useStreamFollow } from '../workspace/useStreamFollow.js';
import '../styles/desktop.css';
import { useRuntimeAdapter } from '../runtimeContext.js';
import { copyText as writeClipboardText } from '../workspace/clipboard.js';
import { formatPayloadOnBlur, getPayloadValidity } from '../workspace/payloadEditorState.js';
import { publishOnce } from '../workspace/publishWorkflow.js';
import { withTimeout } from '../workspace/withTimeout.js';
import { encodePayload, formatReceivedPayload, formatReceivedPayloadPreview, toHexPreview } from '@ineed-mqtt-tool/codecs/payload-codec';
import { createHistoryPayload } from '../workspace/historyPayload.js';
import { buildConnectionStatusLog } from '@ineed-mqtt-tool/domain/connection-diagnostics';
import { defaultSettings, mergeSettings } from '../workspace/settingsModel.js';
import { createBatchedPersistence } from '../workspace/batchedPersistence.js';
import { appendRealtimeItemsByConnection, createRealtimeItemId, normalizeLimit, trimRealtimeItemsByConnection } from '../workspace/realtimeItems.js';
import { filterMessages } from '../workspace/messageFilters.js';
import { createSubscriptionLifecycle } from '../workspace/subscriptionLifecycle.js';
import { shouldShowLog } from '../workspace/logLevel.js';
import {
  assignSubscriptionColor,
  buildSubscriptionWarning,
  getSubscriptionColor,
  incrementMatchedSubscriptionCounts,
  matchMessageSubscriptions,
  resetSubscriptionMessageCounts,
  shouldReassignSubscriptionColor
} from '@ineed-mqtt-tool/domain/subscription-routing';
import {
  applyPersistedMessageCounts,
  cloneConnectionModel,
  createConnectionFromDraft,
  createEditConnectionDraft,
  createNewConnectionDraft,
  defaultPorts,
  incrementConnectionMessageCount,
  normalizeRuntimeConnection,
  normalizeSubscription,
  protocolOptions,
  toDbConnection,
  validateConnectionDraft
} from '@ineed-mqtt-tool/domain/connection-model';
import { formatTimestamp } from '../workspace/timeFormat.js';
import { formatStorageBytes, normalizeStorageStats } from '../workspace/storageStats.js';
import { createRuntimeFacade } from '../workspace/runtimeFacade.js';
import { getRuntimePresentation } from '../workspace/runtimePresentation.js';
import { createSettingsPersistence } from '../workspace/settingsPersistence.js';
import { validateHttpsUpdateUrl } from '../workspace/updateUrl.js';
import { prepareUpdate } from '../workspace/prepareUpdate.js';
import UpdateProgress from '../components/UpdateProgress.vue';
import ScenarioPanel from '../components/ScenarioPanel.vue';
import { createScenarioRepository } from '../workspace/scenarioRepository.js';
import { createScenarioRunner } from '../workspace/scenarioRunner.js';

const runtimeFacade = createRuntimeFacade(useRuntimeAdapter());
const runtimePresentation = getRuntimePresentation(runtimeFacade.runtimeName);
const vFocus = { mounted: element => { element.dataset.autofocus = ''; } };
const { density, sidebarWidth, sidebarOpen, composerHeight: publishHeight, themePreference,
  resizeSidebar, resizeSidebarWithKeys, subscriptionWidth, subscriptionMaxWidth, resizeSubscriptions, resizeSubscriptionsWithKeys, toggleDensity } = useDesktopLayout('mqtt');
const { subscription: menuSubscription, menu: subscriptionMenuEl, position: subscriptionMenuPosition,
  toggle: toggleSubscriptionMenu, close: closeSubscriptionMenu, keydown: subscriptionMenuKeydown, run: runSubscriptionMenuAction } = useSubscriptionMenu();
const systemTheme = ref(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const theme = computed(() => themePreference.value === 'system' ? systemTheme.value : themePreference.value);
const settingsOpen = ref(false);
const aboutOpen = ref(false);
const websiteError = ref('');
async function openWebsite(event) {
  event.preventDefault();
  if (closing.value) return;
  websiteError.value = '';
  try { await runtimeFacade.window.openExternal(PRODUCT_WEBSITE); }
  catch { websiteError.value = '无法打开浏览器，请复制官网地址后访问。'; }
}
function openAbout(event) {
  event.currentTarget.focus();
  websiteError.value = '';
  aboutOpen.value = true;
}
const settingsDraft = ref({});
const settingsSaving = ref(false);
const settingsDiscard = ref(false);
const draftTheme = ref('system');
const draftDensity = ref('comfortable');
const settingsDirty = computed(() => JSON.stringify(settingsDraft.value) !== JSON.stringify(settings.value)
  || draftTheme.value !== themePreference.value || draftDensity.value !== density.value);
function moveWorkspaceTab(event, id) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = ['messages', 'log', 'scenarios'];
  const index = tabs.indexOf(id);
  activeTab.value = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  nextTick(() => event.target.parentElement?.querySelector('[aria-selected="true"]')?.focus());
}
function openSettings(event) {
  event?.currentTarget?.focus();
  settingsDraft.value = { ...settings.value };
  draftTheme.value = themePreference.value;
  draftDensity.value = density.value;
  settingsError.value = '';
  settingsDiscard.value = false;
  settingsOpen.value = true;
  void refreshStorageStats();
}
function closeSettings(discard = false) {
  if (settingsSaving.value || storageClearing.value) return;
  if (settingsDirty.value && !discard) { settingsDiscard.value = true; return; }
  settingsOpen.value = false;
}
async function saveSettings() {
  if (settingsSaving.value || storageClearing.value || closing.value || !settingsReady) return;
  settingsSaving.value = true;
  settingsError.value = '';
  const candidate = mergeSettings(settingsDraft.value);
  await settingsPersistence.enqueue(candidate);
  if (!settingsError.value) {
    settings.value = candidate;
    themePreference.value = draftTheme.value;
    density.value = draftDensity.value;
    settingsDraft.value = { ...candidate };
    settingsOpen.value = false;
  }
  settingsSaving.value = false;
}
const connectionSearch = ref('');
const visibleConnections = computed(() => connections.value.filter(conn =>
  [conn.name, conn.host, conn.port].join(' ').toLowerCase().includes(connectionSearch.value.toLowerCase())));
const selectedMessage = ref(null);
let detailTrigger = null;
function inspectMessage(message, event) {
  selectedMessage.value = message;
  detailTrigger = event.currentTarget;
  nextTick(() => document.querySelector('.message-inspector__close')?.focus());
}
function closeInspector() {
  if (!selectedMessage.value) return;
  selectedMessage.value = null;
  detailTrigger?.focus();
}
const scheduleOpen = ref(false);
console.log('[Vue] init, runtime:', runtimeFacade.runtimeName);
const mqttApi = runtimeFacade.mqtt;
const dbApi = runtimeFacade.db;
const CLOSE_DRAIN_TIMEOUT_MS = 3000;
const MAX_REALTIME_PAYLOAD_PREVIEW_BYTES = 16 * 1024;
const persistenceDropCounts = new Map();
let disposeMqttMessages = null;
let disposeMqttStatus = null;
let disposeBeforeClose = null;
let persistenceDropWarningTimer = null;
let teardownPromise = null;
const closing = ref(false);
const inFlightOperations = new Set();
// Shell owns the application operation generation and all in-flight promises.
// Close drains work first, then invalidates effects even if an ACK arrives late.
let operationGeneration = 0;
let acceptingOperationEffects = true;
const deferredUiTimers = new Set();

function trackOperation(operation) {
  inFlightOperations.add(operation);
  operation.then(
    () => inFlightOperations.delete(operation),
    () => inFlightOperations.delete(operation),
  );
  return operation;
}

function runTrackedOperation(work) {
  if (closing.value) return Promise.resolve(false);
  const generation = operationGeneration;
  return trackOperation(Promise.resolve().then(() => work(generation)));
}

function isOperationCurrent(generation) {
  return generation === operationGeneration;
}

async function drainInFlightOperations() {
  while (inFlightOperations.size > 0) {
    await Promise.allSettled([...inFlightOperations]);
  }
}

async function drainOperationsForClose() {
  return settleClosePhase(drainInFlightOperations(), '等待后台操作结束超时');
}

async function settleClosePhase(operation, timeoutMessage) {
  try {
    await withTimeout(
      operation,
      CLOSE_DRAIN_TIMEOUT_MS,
      timeoutMessage,
    );
    return true;
  } catch (error) {
    console.warn('[Vue] close phase timed out:', error?.message || error);
    return false;
  }
}

function requireSuccessfulResult(result, fallbackMessage) {
  if (result?.ok === false) throw new Error(result.error || fallbackMessage);
  return result;
}
const messagePersistence = createBatchedPersistence({
  flushMs: 1000,
  maxBatchSize: 200,
  persistBatch: rows => dbApi.saveMessages(rows),
  onError: (error, rows) => reportPersistenceFailure('消息历史', error, rows),
  onDrop: rows => reportPersistenceDrop('消息历史', rows)
});
const logPersistence = createBatchedPersistence({
  flushMs: 1000,
  maxBatchSize: 200,
  persistBatch: rows => dbApi.saveLogs(rows),
  onError: (error, rows) => reportPersistenceFailure('日志历史', error, rows),
  onDrop: rows => reportPersistenceDrop('日志历史', rows)
});

const connections = ref([]);
const messages = shallowRef([]);
const subscriptions = ref([]);
const subscriptionLifecycle = createSubscriptionLifecycle({
  mqtt: mqttApi,
  db: dbApi,
  workspace: {
    getConnection: connId => connections.value.find(connection => connection.id === connId),
    getSubscriptions: () => subscriptions.value,
    replaceSubscriptions: rows => { subscriptions.value = rows; },
    hasConnection: hasActiveConnection,
    isClosing: () => closing.value,
  },
  operations: { run: runTrackedOperation, isCurrent: isOperationCurrent },
  addLog,
});
const scenarioState = ref(0);
const latestScenarioReport = ref(null);
const scenarioRepository = createScenarioRepository({
  getAllSettings: () => trackOperation(dbApi.getAllSettings()),
  saveSetting: (key, value) => trackOperation(dbApi.saveSetting(key, value)),
});
const scenarioRunner = createScenarioRunner({
  trackCleanup: trackOperation,
  mqtt: mqttApi,
  withResponseSubscription: (...args) => trackOperation(subscriptionLifecycle.withResponseSubscription(...args)),
  onState: () => { scenarioState.value += 1; },
  onReport: report => {
    latestScenarioReport.value = report;
    const revision = report.cleanup;
    void trackOperation(scenarioRepository.saveReport(report)).then(() => { scenarioState.value += 1; }, error => {
      if (latestScenarioReport.value?.runId === report.runId && latestScenarioReport.value.cleanup === revision) {
        latestScenarioReport.value = { ...report, persistenceError: error?.message || String(error) };
      }
      scenarioState.value += 1;
    });
  },
});


const settings = ref({ ...defaultSettings });
const settingsError = ref('');
const actionError = ref('');
let settingsReady = false;
let dataRequestGeneration = 0;
let activeLoadRequest = null;
const settingsPersistence = createSettingsPersistence({
  persist: (key, value) => dbApi.saveSetting(key, value),
  onError(error, key) {
    settingsError.value = `设置 ${key} 保存失败: ${error?.message || String(error)}`;
    addRealtimeLog('err', settingsError.value, activeConnId.value, false);
  },
});

async function loadSettings(db) {
  const saved = db.getAllSettings ? await db.getAllSettings() : {};
  return { settings: mergeSettings(saved), pendingUnsubscriptions: subscriptionLifecycle.readPendingUnsubscriptions(saved) };
}


function getRealtimeMessageLimit() {
  return normalizeLimit(settings.value.maxRealtimeMessages, defaultSettings.maxRealtimeMessages);
}

function getRealtimeLogLimit() {
  return normalizeLimit(settings.value.maxLogEntries, defaultSettings.maxLogEntries);
}

async function loadData() {
  if (closing.value) return false;
  const requestGeneration = ++dataRequestGeneration;
  const operationToken = operationGeneration;
  activeLoadRequest?.cancel();
  dataState.value = 'loading';
  dataError.value = '';
  settingsReady = false;
  const db = dbApi;
  const underlyingLoad = trackOperation((async () => {
    const loadedSettings = await loadSettings(db);
    if (!isOperationCurrent(operationToken)) return null;
    const [conns = [], messageCounts = []] = await Promise.all([
      db.getConnections(),
      db.getMessageCounts()
    ]);
    if (!isOperationCurrent(operationToken)) return null;
    const loadedConnections = conns.map(normalizeRuntimeConnection);
    applyPersistedMessageCounts(loadedConnections, messageCounts);
    const loadedSubscriptions = [];
    for (const connection of conns) {
      const subs = await db.getSubscriptions(connection.id);
      if (!isOperationCurrent(operationToken)) return null;
      for (const sub of (subs || []).map(normalizeSubscription)) {
        if (shouldReassignSubscriptionColor(loadedSubscriptions, sub)) {
          sub.color = assignSubscriptionColor(loadedSubscriptions, sub.connId);
          await db.addSubscription({ id: sub.id, connection_id: sub.connId, topic: sub.topic, qos: sub.qos, status: sub.status, color: sub.color, format: sub.format });
          if (!isOperationCurrent(operationToken)) return null;
        }
        loadedSubscriptions.push(sub);
      }
    }
    return { loadedSettings, loadedConnections, loadedSubscriptions };
  })());
  const loadRequest = withTimeout(underlyingLoad, 5000, '工作区数据加载超时');
  activeLoadRequest = loadRequest;

  try {
    const result = await loadRequest;
    if (!result || requestGeneration !== dataRequestGeneration || !isOperationCurrent(operationToken)) return false;
    settings.value = result.loadedSettings.settings;
    subscriptionLifecycle.applyPendingUnsubscriptions(result.loadedSettings.pendingUnsubscriptions);
    connections.value = result.loadedConnections;
    subscriptions.value = result.loadedSubscriptions;
    activeConnId.value = result.loadedConnections[0]?.id || null;
    settingsReady = true;
    dataState.value = 'ready';
    return true;
  } catch (error) {
    if (requestGeneration !== dataRequestGeneration) return false;
    dataError.value = error?.message || String(error || '工作区数据加载失败');
    dataState.value = 'error';
    return false;
  } finally {
    if (activeLoadRequest === loadRequest) activeLoadRequest = null;
  }
}

const activeTab = ref('messages');
const storageStats = ref(normalizeStorageStats());
const storageLoading = ref(false);
const storageClearing = ref(false);
const storageError = ref('');

async function refreshStorageStats() {
  if (closing.value || storageLoading.value || storageClearing.value) return false;
  storageLoading.value = true;
  storageError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      const stats = await dbApi.getStorageStats();
      if (!isOperationCurrent(operationToken)) return false;
      storageStats.value = normalizeStorageStats(stats);
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) storageError.value = error?.message || String(error);
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) storageLoading.value = false;
    }
  });
}

async function clearHistoryStorage() {
  if (closing.value || storageClearing.value) return false;
  const confirmed = window.confirm('确定清空全部历史消息、历史日志和发布历史吗？\n\n不会删除连接、订阅和系统设置。');
  if (!confirmed) return false;
  storageClearing.value = true;
  storageError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      await Promise.all([messagePersistence.flush(), logPersistence.flush()]);
      if (!isOperationCurrent(operationToken)) return false;
      const stats = await dbApi.clearHistoryStorage();
      if (!isOperationCurrent(operationToken)) return false;
      storageStats.value = normalizeStorageStats(stats);
      addRealtimeLog('info', '历史数据已清空，连接、订阅和系统设置已保留', activeConnId.value, false);
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) {
        storageError.value = error?.message || String(error);
        addRealtimeLog('err', '清空历史数据失败: ' + storageError.value, activeConnId.value, false);
      }
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) storageClearing.value = false;
    }
  });
}

const dataState = ref('loading');
const dataError = ref('');
const activeConnId = ref(null);
const filterTopic = ref('');
const filterDir = ref('all');
const selectedSubFilterId = ref('');
const pubTopic = ref('device/actuator/relay/01');
const pubPayload = ref('{"command": "toggle", "state": "on"}');
const pubQos = ref(1);
const pubRetain = ref(false);
const pubFormat = ref('json');
const pubSendMode = ref('plain');
const jsonValid = ref(true);
const publishing = ref(false);
const publishError = ref('');
const lastPublishedMessage = shallowRef(null);
const copyHint = ref('');
let copyHintTimer = null;
function prettifyJson() {
  const formatted = formatPayloadOnBlur(pubPayload.value, pubFormat.value);
  pubPayload.value = formatted;
  jsonValid.value = getPayloadValidity(formatted, pubFormat.value);
}
function formatJsonOnBlur() {
  prettifyJson();
}
const newSubTopic = ref('');
const newSubQos = ref(0);
const newSubFormat = ref('json');

const activeConn = computed(() => connections.value.find(c => c.id === activeConnId.value) || connections.value[0] || {});
const statusLabel = computed(() => ({ connected: '已连接', disconnected: '未连接', connecting: '正在连接', reconnecting: '正在重连', error: '错误' }[activeConn.value.status]));
function hasActiveConnection(connId = activeConnId.value) {
  return dataState.value === 'ready'
    && connId != null
    && connections.value.some(connection => connection.id === connId);
}

const connSubs = computed(() => subscriptions.value.filter(s => s.connId === activeConnId.value));
const copySubTargets = computed(() => connections.value.filter(c => c.id !== subToCopy.value?.connId));
const selectedSubFilter = computed(() => connSubs.value.find(s => s.id === selectedSubFilterId.value) || null);
const subscriptionWarning = computed(() => {
  const topic = newSubTopic.value.trim();
  if (!topic) return null;
  return buildSubscriptionWarning(subscriptions.value, { id: '', connId: activeConnId.value, topic });
});

const msgCountIn = computed(() => activeConn.value.messagesIn || 0);
const msgCountOut = computed(() => activeConn.value.messagesOut || 0);
const canPublish = computed(() => (
  !closing.value
  && hasActiveConnection(activeConn.value.id)
  && activeConn.value.status === 'connected'
  && !!pubTopic.value.trim()
  && !(pubFormat.value === 'json' && !jsonValid.value)
  && !publishing.value
));
const encodedPublishPayload = computed(() => encodePayload(pubPayload.value, pubSendMode.value));
const hexPreview = computed(() => toHexPreview(encodedPublishPayload.value.payload, 18));
const fullHexText = computed(() => toHexPreview(encodedPublishPayload.value.payload, Number.MAX_SAFE_INTEGER).text);

async function copyText(value, label = '内容') {
  if (closing.value) return false;
  return runTrackedOperation(async operationToken => {
    const result = await writeClipboardText(value, runtimeFacade.clipboard);
    if (!isOperationCurrent(operationToken)) return false;
    copyHint.value = result.ok ? '已复制 ' + label : '复制失败';
    clearTimeout(copyHintTimer);
    copyHintTimer = setTimeout(() => { copyHint.value = ''; }, 1400);
    return result.ok;
  });
}

const filteredMsgs = computed(() => {
  return filterMessages(messages.value, {
    connId: activeConnId.value,
    selectedSubscription: selectedSubFilter.value,
    topic: filterTopic.value,
    direction: filterDir.value
  });
});
const publishedMessageHidden = computed(() => {
  const message = lastPublishedMessage.value;
  if (!message || message.connId !== activeConnId.value || publishError.value) return false;
  if (!messages.value.some(item => item.id === message.id)) return false;
  return filterMessages([message], {
    connId: activeConnId.value,
    topic: filterTopic.value,
    direction: filterDir.value
  }).length === 0;
});

async function showSentMessages() {
  filterDir.value = 'out';
  filterTopic.value = '';
  activeTab.value = 'messages';
  await nextTick();
  messageFollow.resume();
}

// Follow state is local to the current viewport, separate from the saved preference.
const chatEl = ref(null);
const logEl = ref(null);
const messageFollow = useStreamFollow({ element: chatEl, keys: () => filteredMsgs.value.map(message => message.id),
  enabled: () => settings.value.autoScroll, context: () => [activeConnId.value, filterTopic.value, filterDir.value, selectedSubFilterId.value].join('|') });
const messageViewport = useMessageViewport({
  items: filteredMsgs, element: chatEl, following: messageFollow.following,
  context: () => `${settings.value.largeFont}|${density.value}`,
  refreshFollow: messageFollow.refresh,
});
function onMessageScroll() { messageFollow.onScroll(); messageViewport.onScroll(); }

async function openHistoryWindow(kind, connId) {
  if (closing.value || !hasActiveConnection(connId)) return false;
  actionError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      // History queries must see the records already visible in the realtime workbench.
      await (kind === 'logs' ? logPersistence : messagePersistence).flush();
      if (!isOperationCurrent(operationToken) || !hasActiveConnection(connId)) return false;
      await runtimeFacade.window.openHistory(kind, connId);
      return isOperationCurrent(operationToken);
    } catch (error) {
      if (isOperationCurrent(operationToken)) actionError.value = error?.message || String(error);
      return false;
    }
  });
}
function subscriptionStyle(sub) {
  const color = getSubscriptionColor(sub);
  return { '--sub-color': color, '--sub-soft': color + '18' };
}
function subscriptionStatusLabel(sub) {
  return ({ active: '已订阅', pending: '订阅中', error: '订阅失败', inactive: '未订阅' })[sub.status] || '未订阅';
}
function connectionInitial(conn) {
  const text = String(conn?.name || conn?.host || conn?.id || '?').trim();
  return text.split(/[\s()（）_-]+/u).filter(Boolean).map(part => Array.from(part)[0]).slice(0, 2).join('').toUpperCase() || '?';
}
function connectionTitle(conn) {
  const name = conn?.name || conn?.id || '未命名连接';
  const endpoint = conn?.host ? conn.host + ':' + conn.port : '';
  const status = ({ connected: '已连接', disconnected: '未连接', connecting: '连接中', error: '错误' })[conn?.status] || conn?.status || '未知';
  return [name, endpoint, status].filter(Boolean).join(' · ');
}
function toggleSubscriptionFilter(sub) {
  selectedSubFilterId.value = selectedSubFilterId.value === sub.id ? '' : sub.id;
  activeTab.value = 'messages';
}
function clearSubscriptionFilter() {
  selectedSubFilterId.value = '';
}
function messageByteLength(message) { return new TextEncoder().encode(message.payload ?? '').length; }
function getMessageSubStyle(msg) {
  const sub = msg.primarySubscription;
  return sub ? subscriptionStyle(sub) : {};
}
function describeMessageSubscription(msg) {
  if (!msg.primarySubscription) return '';
  const extra = Math.max(0, (msg.matchedSubscriptions?.length || 0) - 1);
  return '订阅 ' + msg.primarySubscription.topic + (extra ? ' +' + extra : '');
}

// ---- Record successful publish ----
async function recordPublishSuccess(published, operationToken) {
  const { connectionId, topic, payload, qos, retain, format, sendMode, encoded } = published;
  const newMsg = {
    id: createRealtimeItemId('msg'), connId: connectionId, time: formatTime(),
    topic, payload, direction: 'out',
    qos, retained: retain,
    inputFormat: format, sendMode, byteLength: encoded.byteLength
  };
  messages.value = appendRealtimeItemsByConnection(messages.value, [newMsg], getRealtimeMessageLimit());
  if (connectionId === activeConnId.value) lastPublishedMessage.value = newMsg;
  incrementConnectionMessageCount(connections.value, connectionId, 'out');
  {
    const historyPayload = createHistoryPayload({
      payload,
      bytes: encoded.payload instanceof Uint8Array ? encoded.payload : undefined,
      format: sendMode === 'hex' ? 'hex' : format,
    });
    try {
      messagePersistence.enqueue({ connection_id: connectionId, topic, ...historyPayload, direction: 'out', qos, retained: retain ? 1 : 0 });
    } catch (error) {
      addLog('err', '消息历史保存失败: ' + (error?.message || String(error)), connectionId);
    }
    try {
      await dbApi.savePublish({ connection_id: connectionId, topic, payload, qos, retained: retain ? 1 : 0 });
    } catch (error) {
      if (isOperationCurrent(operationToken)) {
        addLog('err', '发布历史保存失败: ' + (error?.message || String(error)), connectionId);
      }
    }
  }
}

// ---- CRUD: Subscribe ----
function doSubscribe() {
  if (closing.value || subscriptionMutating.value || !hasActiveConnection()) return false;
  const topic = newSubTopic.value.trim();
  if (!topic) return false;
  const sub = { id: 'sub-' + Date.now(), connId: activeConnId.value, topic, qos: newSubQos.value, format: newSubFormat.value, status: 'active', color: assignSubscriptionColor(subscriptions.value, activeConnId.value), messageCount: 0, lastMessage: '' };
  subscriptionMutating.value = true;
  subscriptionMutationError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      await subscriptionLifecycle.addSubscription(sub, operationToken);
      if (!isOperationCurrent(operationToken)) return false;
      newSubTopic.value = '';
      showSubModal.value = false;
      return true;
    } catch (error) {
      subscriptionMutationError.value = error?.message || String(error);
      return false;
    } finally {
      subscriptionMutating.value = false;
    }
  });
}

// ---- CRUD: Remove Subscription ----
const subToDel = ref(null);
const subToCopy = ref(null);
const copySubTargetConnId = ref('');
const subscriptionMutating = ref(false);
const subscriptionMutationError = ref('');
function confirmRemoveSub(sub) {
  subscriptionMutationError.value = '';
  subToDel.value = sub;
}
async function removeSubscription() {
  if (closing.value || !subToDel.value || subscriptionMutating.value) return false;
  const sub = subToDel.value;
  subscriptionMutating.value = true;
  subscriptionMutationError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      const removed = await subscriptionLifecycle.removeSubscription(sub, operationToken);
      if (!removed || !isOperationCurrent(operationToken)) return false;
      if (selectedSubFilterId.value === sub.id) selectedSubFilterId.value = '';
      subToDel.value = null;
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) subscriptionMutationError.value = error?.message || String(error);
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) subscriptionMutating.value = false;
    }
  });
}

function openCopySubscription(sub) {
  if (closing.value) return;
  subscriptionMutationError.value = '';
  subToCopy.value = sub;
  copySubTargetConnId.value = connections.value.find(c => c.id !== sub.connId)?.id || '';
  resetModalPos();
}
function copySubscriptionToConnection() {
  if (closing.value || subscriptionMutating.value || !subToCopy.value || !copySubTargetConnId.value) return false;
  const source = subToCopy.value;
  const targetConnId = copySubTargetConnId.value;
  const target = connections.value.find(c => c.id === targetConnId);
  const existing = subscriptions.value.find(s => s.connId === targetConnId && s.topic === source.topic);
  const copied = {
    ...(existing || {}),
    id: existing?.id || 'sub-' + Date.now(),
    connId: targetConnId,
    topic: source.topic,
    qos: source.qos,
    format: source.format || 'json',
    status: target?.status === 'connected' ? 'active' : 'inactive',
    color: existing?.color || assignSubscriptionColor(subscriptions.value, targetConnId),
    messageCount: existing?.messageCount || 0,
    lastMessage: existing?.lastMessage || ''
  };
  const targetConnected = target?.status === 'connected';
  subscriptionMutating.value = true;
  subscriptionMutationError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      const saved = await subscriptionLifecycle.copySubscription({ source, copied, existing, target, targetConnected }, operationToken);
      if (!saved || !isOperationCurrent(operationToken)) return false;
      subToCopy.value = null;
      copySubTargetConnId.value = '';
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) subscriptionMutationError.value = error?.message || String(error);
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) subscriptionMutating.value = false;
    }
  });
}

// ---- CRUD: Delete Connection ----
const deletingConnectionId = ref(null);
const connectionMutationError = ref('');
async function deleteConnection(connId) {
  if (closing.value || !connId || deletingConnectionId.value) return false;
  deletingConnectionId.value = connId;
  connectionMutationError.value = '';
  subscriptionLifecycle.beginConnectionRequest(connId);
  return runTrackedOperation(async operationToken => {
    try {
      requireSuccessfulResult(await mqttApi.disconnect(connId), 'Broker 断开连接失败');
      if (!isOperationCurrent(operationToken)) return false;
      requireSuccessfulResult(await dbApi.deleteConnection(connId), '连接删除失败');
      if (!isOperationCurrent(operationToken)) return false;
      for (const sub of subscriptions.value.filter(item => item.connId === connId)) {
        subscriptionLifecycle.clearSubscriptionPending(sub);
      }
      subscriptions.value = subscriptions.value.filter(item => item.connId !== connId);
      connections.value = connections.value.filter(c => c.id !== connId);
      if (activeConnId.value === connId) activeConnId.value = connections.value[0]?.id || null;
      if (!connections.value.some(c => c.id === activeConnId.value)) selectedSubFilterId.value = '';
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) connectionMutationError.value = error?.message || String(error);
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) deletingConnectionId.value = null;
    }
  });
}

const cloningConnectionId = ref(null);
function cloneConnection(conn) {
  if (closing.value || cloningConnectionId.value) return false;
  const copy = cloneConnectionModel(conn, connections.value.length);
  cloningConnectionId.value = conn.id;
  actionError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      requireSuccessfulResult(await dbApi.saveConnection(toDbConnection(copy)), '连接克隆保存失败');
      if (!isOperationCurrent(operationToken)) return false;
      connections.value.push(copy);
      activeConnId.value = copy.id;
      addLog('info', '已克隆连接: ' + copy.name, copy.id);
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) actionError.value = error?.message || String(error);
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) cloningConnectionId.value = null;
    }
  });
}

// ---- CRUD: Create / Edit Connection ----
const showNewConn = ref(false);
const editingConnId = ref(null);
const newConn = ref(createNewConnectionDraft());
const connectionSaving = ref(false);
const connectionSaveError = ref('');
function onProtocolChange(e) { newConn.value.protocol = e.target.value; newConn.value.port = defaultPorts[newConn.value.protocol]; }
const modalTitle = computed(() => editingConnId.value ? '编辑连接' : '新建连接');

function openNewConn() { if (closing.value) return; editingConnId.value = null; connErrors.value = {}; connectionSaveError.value = ''; newConn.value = createNewConnectionDraft(settings.value.keepalive, settings.value.cleanSession); showNewConn.value = true; }
function editConnection(conn) {
  if (closing.value) return;
  editingConnId.value = conn.id; connErrors.value = {};
  connectionSaveError.value = '';
  newConn.value = createEditConnectionDraft(conn);
  showNewConn.value = true;
}
const connErrors = ref({});
function validate(field) {
  const e = validateConnectionDraft(newConn.value, field);
  if (field) { connErrors.value = { ...connErrors.value, [field]: e[field] }; }
  else { connErrors.value = e; }
  return Object.keys(e).length === 0;
}
function saveConnection() {
  if (closing.value || connectionSaving.value || !validate()) return false;
  const editId = editingConnId.value;
  const existingIndex = editId ? connections.value.findIndex(c => c.id === editId) : -1;
  if (editId && existingIndex < 0) return false;
  const editedConfig = { ...newConn.value, updated_at: new Date().toISOString() };
  const savedConn = editId
    ? { ...connections.value[existingIndex], ...editedConfig }
    : createConnectionFromDraft(newConn.value, connections.value.length);
  connectionSaving.value = true;
  connectionSaveError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      requireSuccessfulResult(await dbApi.saveConnection(toDbConnection(savedConn)), '连接保存失败');
      if (!isOperationCurrent(operationToken)) return false;
      if (editId) {
        // Runtime events keep updating status/counters while persistence is pending.
        const current = connections.value.find(conn => conn.id === editId);
        if (current) Object.assign(current, editedConfig);
      }
      else {
        connections.value.push(savedConn);
        activeConnId.value = savedConn.id;
      }
      showNewConn.value = false;
      editingConnId.value = null;
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken)) connectionSaveError.value = error?.message || String(error);
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) connectionSaving.value = false;
    }
  });
}

// ---- Clear Realtime View ----
function clearRealtimeLogs() { logs.value = logs.value.filter(l => l.connId !== activeConnId.value); }

function clearRealtimeMessages() {
  lastPublishedMessage.value = null;
  messages.value = messages.value.filter(m => m.connId !== activeConnId.value);
  resetSubscriptionMessageCounts(subscriptions.value, activeConnId.value);
}

// ---- Version Check ----
const checking = ref(false);
const updateInfo = ref(null);
const updateState = ref({ phase: 'idle', supported: false });
const updateBusy = computed(() => ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(updateState.value.phase));
let disposeUpdateState = null;
let updatePreparing = false;
let updatePreparation = null;
function acceptUpdateState(state) {
  updateState.value = state;
  if (state.phase === 'preparing') {
    closing.value = true;
    updatePreparing = true;
  }
  if (['available', 'ready', 'error'].includes(state.phase) && updatePreparing && !teardownPromise) {
    closing.value = false;
    updatePreparing = false;
  }
}
async function prepareForUpdate() {
  if (teardownPromise) throw new Error('应用正在关闭');
  if (updatePreparation) return updatePreparation;
  closing.value = true;
  updatePreparing = true;
  scenarioRunner.stop();
  stopPublishTimer();
  updatePreparation = prepareUpdate({
    drain: drainInFlightOperations,
    disconnect: async signal => {
      subscriptionLifecycle.clearPendingTimers();
      await Promise.all(connections.value.map(async connection => {
        const result = await mqttApi.disconnect(connection.id);
        requireSuccessfulResult(result, '更新前断开 MQTT 失败');
        signal.throwIfAborted();
        connection.status = 'disconnected';
      }));
      // Let delivered native events enqueue their persistence work before flushing.
      await nextTick();
    },
    writers: [settingsPersistence, messagePersistence, logPersistence],
  }).catch(error => {
    closing.value = false;
    updatePreparing = false;
    throw error;
  }).finally(() => { updatePreparation = null; });
  return updatePreparation;
}
async function runUpdateAction(method) {
  try { await runtimeFacade.update[method](); }
  catch (error) {
    updateState.value = { ...updateState.value, error: error.message };
    if (method === 'install' && !teardownPromise) { closing.value = false; updatePreparing = false; }
  }
}
async function checkUpdate() {
  if (closing.value || checking.value || updateBusy.value) return false;
  checking.value = true; updateInfo.value = null;
  return runTrackedOperation(async operationToken => {
    try {
      const data = await runtimeFacade.update.check();
      if (!isOperationCurrent(operationToken)) return false;
      updateInfo.value = data;
      return true;
    } catch(e) {
      if (isOperationCurrent(operationToken)) updateInfo.value = { error: e.message };
      return false;
    } finally {
      if (isOperationCurrent(operationToken)) checking.value = false;
    }
  });
}

async function openUpdateDownload() {
  if (closing.value) return false;
  if (updateInfo.value?.automatic) {
    await runUpdateAction('download');
    return true;
  }
  const url = validateHttpsUpdateUrl(updateInfo.value?.url);
  if (!url) {
    actionError.value = '更新下载地址无效';
    return false;
  }
  actionError.value = '';
  return runTrackedOperation(async operationToken => {
    try {
      await runtimeFacade.window.openExternal(url);
      return isOperationCurrent(operationToken);
    } catch (error) {
      if (isOperationCurrent(operationToken)) actionError.value = error?.message || String(error);
      return false;
    }
  });
}

// ---- Delete Confirmation ----
const showSubModal = ref(false);
const delTarget = ref(null);
function askDelete(conn) { if (closing.value) return; connectionMutationError.value = ''; delTarget.value = conn; }
async function confirmDelete() {
  if (!delTarget.value) return false;
  const deleted = await deleteConnection(delTarget.value.id);
  if (deleted) delTarget.value = null;
  return deleted;
}

// ---- Event Log ----
const logs = shallowRef([]);
const logFilter = ref('');
watch(() => settings.value.maxRealtimeMessages, () => {
  messages.value = trimRealtimeItemsByConnection(messages.value, getRealtimeMessageLimit());
});
watch(() => settings.value.maxLogEntries, () => {
  logs.value = trimRealtimeItemsByConnection(logs.value, getRealtimeLogLimit());
});
function formatTime() {
  return formatTimestamp(Date.now());
}
function enqueueLog(entry) {
  // The legacy time column follows the saved display setting. Keep that
  // storage/export contract while the in-memory UI retains the full date.
  const time = settings.value.timestampFormat === 'absolute' ? entry.time.split(' ').at(-1) : entry.time;
  logPersistence.enqueue({ ...entry, time });
}
function logLineText(log) {
  return '[' + log.time + '] ' + (log.level || '').toUpperCase() + ' ' + log.msg;
}
function addLog(level, msg, connId) {
  addRealtimeLog(level, msg, connId, true);
}

function addRealtimeLog(level, msg, connId, persist = true) {
  if (!acceptingOperationEffects) return;
  if (!shouldShowLog(level, settings.value.logLevel)) return;
  const entry = { time: formatTime(), level, msg, connId: connId || activeConnId.value };
  logs.value = appendRealtimeItemsByConnection(logs.value, [entry], getRealtimeLogLimit());
  if (persist) {
    try { enqueueLog(entry); } catch (error) { console.warn('[Vue] saveLog skipped:', error.message); }
  }
}

function persistenceConnectionId(rows) {
  return rows.find(row => row?.connection_id || row?.connId)?.connection_id
    || rows.find(row => row?.connection_id || row?.connId)?.connId
    || activeConnId.value;
}

function reportPersistenceFailure(label, error, rows) {
  const message = error?.message || String(error);
  addRealtimeLog('err', `${label}入库失败，已丢弃 ${rows.length} 条: ${message}`, persistenceConnectionId(rows), false);
}

function reportPersistenceDrop(label, rows) {
  const connId = persistenceConnectionId(rows);
  const key = `${label}\u0000${connId || ''}`;
  const current = persistenceDropCounts.get(key) || { label, connId, count: 0 };
  current.count += rows.length;
  persistenceDropCounts.set(key, current);
  if (!persistenceDropWarningTimer) {
    persistenceDropWarningTimer = setTimeout(flushPersistenceDropWarnings, 1000);
  }
}

function flushPersistenceDropWarnings() {
  persistenceDropWarningTimer = null;
  for (const { label, connId, count } of persistenceDropCounts.values()) {
    addRealtimeLog('warn', `${label}入库队列已满，丢弃最旧 ${count} 条`, connId, false);
  }
  persistenceDropCounts.clear();
}

const filteredLogs = computed(() => {
  const keyword = logFilter.value.trim().toLowerCase();
  return logs.value.filter(l => {
    if (l.connId !== activeConnId.value) return false;
    if (!keyword) return true;
    return [l.time, l.level, l.msg].some(v => String(v || '').toLowerCase().includes(keyword));
  });
});

const logFollow = useStreamFollow({ element: logEl, keys: () => filteredLogs.value.map(log => log.id ?? log),
  enabled: () => settings.value.autoScroll, context: () => [activeConnId.value, logFilter.value].join('|') });

// ---- Real MQTT ----
async function connectMqtt(conn) {
  if (closing.value || !hasActiveConnection(conn?.id)) return false;
  const cid = conn.id;
  const requestToken = subscriptionLifecycle.beginConnectionRequest(cid);
  updateConnStatus(cid, 'connecting');
  addLog('info', '连接: ' + conn.host + ':' + conn.port, cid);
  return runTrackedOperation(async operationToken => {
    try {
      const connectionInput = JSON.parse(JSON.stringify(conn));
      connectionInput.autoReconnect = settings.value.autoReconnect;
      const res = await mqttApi.connect(connectionInput);
      if (!isOperationCurrent(operationToken) || !subscriptionLifecycle.isConnectionRequestCurrent(cid, requestToken)) return false;
      if (res.ok) {
        updateConnStatus(cid, 'connected');
        addLog('info', '✓ 已连接', cid);
        await subscriptionLifecycle.restoreConnectionSubscriptions(cid);
        if (!isOperationCurrent(operationToken) || !subscriptionLifecycle.isConnectionRequestCurrent(cid, requestToken)) return false;
      } else if (connections.value.find(item => item.id === cid)?.status !== 'disconnected') {
        updateConnStatus(cid, 'error');
      }
      return !!res.ok;
    } catch(e) {
      if (!isOperationCurrent(operationToken) || !subscriptionLifecycle.isConnectionRequestCurrent(cid, requestToken)) return false;
      updateConnStatus(cid, 'error');
      addLog('err', '连接调用异常: ' + e.message, cid);
      return false;
    }
  });
}
async function stopMqttConnection(connId = activeConnId.value) {
  if (closing.value || !hasActiveConnection(connId)) return false;
  const requestToken = subscriptionLifecycle.beginConnectionRequest(connId);
  return runTrackedOperation(async operationToken => {
    try {
      requireSuccessfulResult(await mqttApi.disconnect(connId), 'Broker 断开连接失败');
      if (!isOperationCurrent(operationToken) || !subscriptionLifecycle.isConnectionRequestCurrent(connId, requestToken)) return false;
      updateConnStatus(connId, 'disconnected');
      subscriptions.value.forEach(s => {
        if (s.connId === connId) {
          subscriptionLifecycle.clearSubscriptionPending(s);
          s.status = 'inactive';
        }
      });
      return true;
    } catch (error) {
      if (isOperationCurrent(operationToken) && subscriptionLifecycle.isConnectionRequestCurrent(connId, requestToken)) {
        actionError.value = error?.message || String(error);
        addLog('err', '断开连接失败: ' + actionError.value, connId);
      }
      return false;
    }
  });
}
function disconnectMqtt() {
  return stopMqttConnection(activeConnId.value);
}
async function disconnectAll() {
  subscriptionLifecycle.clearPendingTimers();
  const results = await Promise.allSettled(
    connections.value.map(connection => mqttApi.disconnect(connection.id)),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[Vue] disconnect during teardown failed:', result.reason?.message || result.reason);
    }
  }
}
function updateConnStatus(connId, status) {
  scenarioRunner.connectionStatus(connId, status);
  subscriptionLifecycle.updateConnectionStatus(connId, status);
}

function handleMqttStatus(event) {
  if (closing.value || !event?.connId || !event.status) return;
  const connection = connections.value.find(item => item.id === event.connId);
  const previousStatus = connection?.status;
  const effectiveEvent = {
    ...event,
    attempt: Number(event.attempt) || Number(connection?.reconnectAttempt) || 0,
    disconnectedAt: event.disconnectedAt || connection?.disconnectedAt || null,
  };
  updateConnStatus(event.connId, event.status);
  if (connection) {
    connection.reconnectAttempt = effectiveEvent.attempt;
    connection.disconnectedAt = effectiveEvent.disconnectedAt;
  }
  const logEntry = buildConnectionStatusLog(effectiveEvent, {
    previousStatus,
    subscriptionCount: subscriptions.value.filter(item => item.connId === event.connId).length,
  });
  if (logEntry) addLog(logEntry.level, logEntry.message, event.connId);
  if (event.status === 'connected' && event.reconnected) {
    void subscriptionLifecycle.restoreConnectionSubscriptions(event.connId);
  }
}

async function realPublish() {
  if (closing.value || publishing.value) return false;
  publishError.value = '';
  const connection = activeConn.value;
  if (!hasActiveConnection(connection?.id)) {
    publishError.value = '请先连接 MQTT Broker';
    return false;
  }
  if (pubFormat.value === 'json' && !jsonValid.value) {
    publishError.value = 'JSON 格式无效';
    addLog('err', '发布失败: ' + publishError.value, connection?.id);
    return false;
  }
  const encoded = encodedPublishPayload.value;
  const published = {
    connectionId: connection?.id,
    payload: pubPayload.value,
    qos: pubQos.value,
    retain: pubRetain.value,
    format: pubFormat.value,
    sendMode: pubSendMode.value,
    encoded,
  };
  publishing.value = true;
  return runTrackedOperation(async operationToken => {
    try {
      const result = await publishOnce({
        mqtt: mqttApi,
        connection,
        topic: pubTopic.value,
        payload: encoded.payload,
        qos: published.qos,
        retain: published.retain,
      });
      if (!isOperationCurrent(operationToken)) return false;
      if (!result.ok) {
        publishError.value = result.error;
        addLog('err', '发布失败: ' + result.error, connection?.id);
        return false;
      }
      await recordPublishSuccess({ ...published, topic: result.topic }, operationToken);
      if (!isOperationCurrent(operationToken)) return false;
      addLog('pub', '发布 → ' + result.topic + ' QoS' + published.qos + (published.retain ? ' [R]' : '') + (published.sendMode === 'hex' ? ' [HEX ' + encoded.byteLength + ' bytes]' : ''), connection.id);
      return true;
    } finally {
      if (isOperationCurrent(operationToken)) publishing.value = false;
    }
  });
}

function teardown() {
  if (teardownPromise) return teardownPromise;

  closing.value = true;
  scenarioRunner.stop();
  dataRequestGeneration += 1;
  settingsReady = false;
  activeLoadRequest?.cancel();
  activeLoadRequest = null;
  const messageDisposer = disposeMqttMessages;
  const statusDisposer = disposeMqttStatus;
  const beforeCloseDisposer = disposeBeforeClose;
  const updateDisposer = disposeUpdateState;
  disposeMqttMessages = null;
  disposeMqttStatus = null;
  disposeBeforeClose = null;
  disposeUpdateState = null;
  clearTimeout(copyHintTimer);
  clearTimeout(persistenceDropWarningTimer);
  persistenceDropWarningTimer = null;
  for (const timer of deferredUiTimers) clearTimeout(timer);
  deferredUiTimers.clear();
  stopModalDrag();
  stopPublishTimer();

  teardownPromise = (async () => {
    await Promise.allSettled([
      Promise.resolve().then(() => messageDisposer?.()),
      Promise.resolve().then(() => statusDisposer?.()),
      Promise.resolve().then(() => beforeCloseDisposer?.()),
      Promise.resolve().then(() => updateDisposer?.()),
    ]);
    await drainOperationsForClose();
    operationGeneration += 1;
    acceptingOperationEffects = false;
    await settleClosePhase(Promise.allSettled([
      settingsPersistence.flush(),
      messagePersistence.flush(),
      logPersistence.flush(),
    ]), '关闭前数据保存超时');
    await settleClosePhase(disconnectAll(), '关闭 MQTT 连接超时');
  })();
  return teardownPromise;
}

onUnmounted(() => {
  stopPublishTimer();
  void teardown();
});

// Timed publish
const timerInterval = ref(5);
const timerRunning = ref(false);
const timerCountdown = ref(0);
let timerId = null;
function isValidTimerInterval(value) {
  const interval = Number(value);
  return Number.isFinite(interval) && Number.isInteger(interval) && interval >= 1 && interval <= 999;
}
const canStartTimer = computed(() => canPublish.value && isValidTimerInterval(timerInterval.value));
function stopPublishTimer() {
  clearInterval(timerId);
  timerId = null;
  timerRunning.value = false;
  timerCountdown.value = 0;
}
function toggleTimer() {
  if (timerRunning.value) {
    stopPublishTimer();
  } else {
    const interval = Number(timerInterval.value);
    if (!Number.isFinite(interval) || !Number.isInteger(interval) || interval < 1 || interval > 999) {
      publishError.value = '定时间隔必须为 1 到 999 的整数';
      return;
    }
    if (!canStartTimer.value) return;
    timerInterval.value = interval;
    timerCountdown.value = interval;
    timerRunning.value = true;
    timerId = setInterval(() => {
      timerCountdown.value -= 1;
      if (timerCountdown.value <= 0) {
        void realPublish();
        timerCountdown.value = interval;
      }
    }, 1000);
  }
}

const connectionDrafts = new Map();
watch(activeConnId, (id, previous) => {
  lastPublishedMessage.value = null;
  closeSubscriptionMenu();
  stopPublishTimer();
  if (previous) connectionDrafts.set(previous, { topic: pubTopic.value, payload: pubPayload.value, qos: pubQos.value,
    retain: pubRetain.value, format: pubFormat.value, mode: pubSendMode.value, filter: filterTopic.value, direction: filterDir.value, subscription: selectedSubFilterId.value });
  const draft = connectionDrafts.get(id);
  pubTopic.value = draft?.topic ?? 'device/actuator/relay/01';
  pubPayload.value = draft?.payload ?? '{"command": "toggle", "state": "on"}';
  pubQos.value = draft?.qos ?? settings.value.defaultQos;
  pubRetain.value = draft?.retain ?? false;
  pubFormat.value = draft?.format ?? 'json';
  pubSendMode.value = draft?.mode ?? 'plain';
  filterTopic.value = draft?.filter ?? '';
  filterDir.value = draft?.direction ?? 'all';
  selectedSubFilterId.value = draft?.subscription ?? '';
  jsonValid.value = getPayloadValidity(pubPayload.value, pubFormat.value);
  publishError.value = '';
  selectedMessage.value = null;
}, { flush: 'sync' });
watch(() => activeConn.value.status, status => { if (status !== 'connected') stopPublishTimer(); });
const mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const updateSystemTheme = event => { systemTheme.value = event.matches ? 'dark' : 'light'; };
onMounted(() => mediaQuery?.addEventListener('change', updateSystemTheme));
onUnmounted(() => mediaQuery?.removeEventListener('change', updateSystemTheme));

// Draggable splitter between chat and publish bar
const PUBLISH_MIN_HEIGHT = 180;
const dragging = ref(false);
function onDragStart(e) { dragging.value = true; e.preventDefault(); }
function onDragMove(e) {
  if (!dragging.value) return;
  const main = e.currentTarget.closest('.main-area');
  if (!main) return;
  const rect = main.getBoundingClientRect();
  const h = rect.bottom - e.clientY;
  const maxHeight = rect.height * 0.5;
  publishHeight.value = Math.max(PUBLISH_MIN_HEIGHT, Math.min(maxHeight, h));
}
function onDragEnd() { dragging.value = false; }

// Draggable modal
const modalPos = ref({ x: 0, y: 0 });
const modalDrag = ref(false);
const modalStart = ref({ x: 0, y: 0 });
const justDragged = ref(false);
function startModalDrag(e) {
  justDragged.value = false;
  modalDrag.value = true;
  modalStart.value = { x: e.clientX - modalPos.value.x, y: e.clientY - modalPos.value.y };
  document.addEventListener('mousemove', onModalDrag);
  document.addEventListener('mouseup', stopModalDrag);
}
function onModalDrag(e) {
  if (!modalDrag.value) return;
  justDragged.value = true;
  const x = e.clientX - modalStart.value.x;
  const y = e.clientY - modalStart.value.y;
  modalPos.value = { x, y };
}

function closeModalIfNotDragged(fn) {
  if (justDragged.value) { justDragged.value = false; return; }
  fn();
}
function stopModalDrag() {
  modalDrag.value = false;
  document.removeEventListener('mousemove', onModalDrag);
  document.removeEventListener('mouseup', stopModalDrag);
}
function resetModalPos() { modalPos.value = { x: 0, y: 0 }; }

onMounted(() => {
  void loadData();
  disposeMqttMessages = mqttApi?.onMessages(processIncomingMessages);
  disposeMqttStatus = mqttApi?.onStatus(handleMqttStatus);
  disposeBeforeClose = runtimeFacade.lifecycle.onBeforeClose(request => request?.purpose === 'update' ? prepareForUpdate() : teardown());
  disposeUpdateState = runtimeFacade.update.onState(acceptUpdateState);
  void runtimeFacade.update.getState().then(acceptUpdateState).catch(() => {});
});

function processIncomingMessages(batch) {
  scenarioRunner.acceptMessages(batch);
  if (closing.value && !updatePreparing) return;
  const incoming = Array.isArray(batch) ? batch : [batch];
  const realtimeMessages = [];
  const receiveLogs = [];
  const showReceiveLogs = shouldShowLog('debug', settings.value.logLevel);

  for (const data of incoming) {
    if (!data?.connId) continue;
    const matchedSubscriptions = matchMessageSubscriptions(subscriptions.value, data.connId, data.topic);
    const primarySubscription = matchedSubscriptions[0] || null;
    const format = primarySubscription?.format || settings.value.payloadFormat;
    const formatOptions = {
      autoFormatJson: settings.value.autoFormatReceivedJson,
      maxFormatBytes: settings.value.maxAutoFormatPayloadBytes,
      byteLength: data.byteLength
    };
    const preview = formatReceivedPayloadPreview(data.payload, format, data.payloadHex, {
      ...formatOptions,
      maxDisplayBytes: MAX_REALTIME_PAYLOAD_PREVIEW_BYTES,
    });
    const copyPayload = preview.truncated
      ? formatReceivedPayload(data.payload, format, data.payloadHex, formatOptions)
      : preview.text;
    realtimeMessages.push({
      id: createRealtimeItemId('msg'), connId: data.connId, time: formatTime(), topic: data.topic,
      payload: data.payload, displayPayload: preview.text, copyPayload, displayTruncated: preview.truncated,
      byteLength: preview.totalBytes, payloadHex: data.payloadHex, direction: 'in',
      qos: data.qos || 0, retained: !!data.retained, primarySubscription, matchedSubscriptions
    });
    incrementConnectionMessageCount(connections.value, data.connId, 'in');
    if (data.historyPersisted !== true) {
      const historyPayload = createHistoryPayload({
        payload: data.payload, payloadHex: data.payloadHex,
        format: primarySubscription?.format || settings.value.payloadFormat,
      });
      messagePersistence.enqueue({ connection_id: data.connId, topic: data.topic, ...historyPayload, direction: 'in', qos: data.qos || 0, retained: data.retained ? 1 : 0 });
    }
    incrementMatchedSubscriptionCounts(matchedSubscriptions);
    matchedSubscriptions.forEach(sub => {
      sub.lastMessage = data.topic;
      sub.lastHitAt = formatTime();
    });
    if (showReceiveLogs) {
      receiveLogs.push({ time: formatTime(), level: 'debug', msg: '收到: ' + data.topic + ' (' + preview.totalBytes + ' bytes)', connId: data.connId });
    }
  }

  messages.value = appendRealtimeItemsByConnection(messages.value, realtimeMessages, getRealtimeMessageLimit());
  if (receiveLogs.length) {
    logs.value = appendRealtimeItemsByConnection(logs.value, receiveLogs, getRealtimeLogLimit());
    if (settings.value.persistReceiveLogs) receiveLogs.forEach(enqueueLog);
  }
}
</script>

<template>
  <div v-show="messageFollow.visible.value" class="mqtt-app" :class="{ 'large-font': settings.largeFont, 'sidebar-collapsed': !sidebarOpen, 'has-subscriptions': Boolean(activeConnId) }" :data-theme="theme" :data-density="density" :style="{ '--resource-width': sidebarWidth + 'px', '--subscription-width': subscriptionWidth + 'px' }" @keydown.esc="closeInspector">
    <div v-if="dataState === 'loading'" class="workspace-state workspace-state--loading" role="status" aria-live="polite">
      <strong>正在加载工作区...</strong>
    </div>
    <div v-else-if="dataState === 'error'" class="workspace-state workspace-state--error" role="alert">
      <strong>工作区加载失败</strong>
      <span>{{ dataError }}</span>
      <button class="modal__btn modal__btn--primary workspace-state__retry" :disabled="closing" @click="loadData">重试</button>
    </div>
    <template v-else>
    <!-- ===== LEFT PANEL ===== -->
    <aside class="left-panel" :class="{ 'left-panel--hidden': !sidebarOpen }">
      <!-- Connections -->
      <div class="panel-header">
        <span class="panel-header__title panel-header__brand">
          <img :src="appIcon" class="app-icon" :alt="sidebarOpen ? '' : 'Ineed MQTT Tool'" title="Ineed MQTT Tool" width="24" height="24">
          <span v-if="sidebarOpen">MQTT Tool</span>
        </span>
        <button class="panel-header__action" type="button" :title="sidebarOpen ? '折叠连接列表' : '展开连接列表'" :aria-label="sidebarOpen ? '折叠连接列表' : '展开连接列表'" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen">
          <PanelLeftClose v-if="sidebarOpen" :size="16" aria-hidden="true" />
          <PanelLeftOpen v-else :size="16" aria-hidden="true" />
        </button>
      </div>
      <div v-if="sidebarOpen" class="resource-toolbar">
        <input v-model="connectionSearch" class="resource-search" type="search" aria-label="查找连接" placeholder="查找连接…">
        <button class="panel-header__action" type="button" title="新建连接" aria-label="新建连接" :disabled="closing" @click="openNewConn"><Plus :size="16" aria-hidden="true" /></button>
      </div>
      <div class="conn-list">
        <div
          v-for="conn in visibleConnections" :key="conn.id"
          :class="['conn-item', 'conn-item--' + conn.status, { 'conn-item--active': activeConnId === conn.id }]"
          :title="connectionTitle(conn)"
          @click.self="activeConnId = conn.id; activeTab = 'messages'"
        >
          <button class="conn-item__select" :aria-label="'选择连接 ' + conn.name" :aria-pressed="activeConnId === conn.id" @click="activeConnId = conn.id; activeTab = 'messages'">
            <span class="sr-only">{{ connectionTitle(conn) }}</span>
          </button>
          <span :class="['conn-item__dot', `conn-item__dot--${conn.status}`]" aria-hidden="true" />
          <span class="conn-item__initial" :title="connectionTitle(conn)">{{ connectionInitial(conn) }}</span>
          <div class="conn-item__info">
            <div class="conn-item__top">
              <span class="conn-item__name">{{ conn.name }}</span>
              <span class="conn-item__actions">
                <button class="conn-item__action-btn conn-item__edit" :disabled="closing" @click.stop="editConnection(conn)" title="编辑连接"><Pencil :size="14" aria-hidden="true" /></button>
                <button class="conn-item__action-btn conn-item__clone" :disabled="cloningConnectionId !== null || closing" @click.stop="cloneConnection(conn)" title="克隆连接"><Copy :size="14" aria-hidden="true" /></button>
                <button class="conn-item__action-btn conn-item__del" :disabled="closing" @click.stop="askDelete(conn)" title="删除连接"><X :size="14" aria-hidden="true" /></button>
              </span>
            </div>
            <span class="conn-item__host" :title="conn.host + ':' + conn.port">{{ conn.host }}:{{ conn.port }}</span>
          </div>
        </div>
      </div>

      <div class="left-bottom">
        <button :class="['left-bottom__btn', { 'left-bottom__btn--active': settingsOpen }]" @click="openSettings" title="设置" aria-label="设置"><Settings :size="15" aria-hidden="true" /> <span>设置</span></button>
        <button :class="['left-bottom__btn', { 'left-bottom__btn--active': aboutOpen }]" @click="openAbout" title="关于" aria-label="关于"><CircleHelp :size="15" aria-hidden="true" /> <span>关于</span></button>
      </div>
    </aside>
    <div v-if="sidebarOpen" class="resource-resizer" role="separator" tabindex="0" aria-label="调整资源栏宽度" aria-orientation="vertical" :aria-valuenow="sidebarWidth" aria-valuemin="210" aria-valuemax="380" @pointerdown="resizeSidebar" @keydown="resizeSidebarWithKeys" />

    <!-- Subscription sidebar -->
    <aside v-if="activeConnId" class="sub-panel subscription-panel" aria-label="当前连接的订阅">
      <div class="panel-header">
        <span class="panel-header__title">当前连接的订阅</span>
        <button class="panel-header__action" title="添加订阅" :disabled="closing" @click="newSubTopic='';newSubQos=settings.defaultQos;newSubFormat='json';subscriptionMutationError='';showSubModal=true"><Plus :size="16" aria-hidden="true" /></button>
      </div>
      <div class="subscription-panel__connection" :title="activeConn.name">{{ activeConn.name }}</div>
      <div class="sub-list">
        <p v-if="connSubs.length === 0" class="subscription-panel__empty">暂无订阅，点击上方按钮添加。</p>
        <div
          v-for="sub in connSubs" :key="sub.id"
          :class="['sub-item', 'sub-item--' + (sub.status || 'inactive'), { 'sub-item--selected': selectedSubFilterId === sub.id }]"
          :style="subscriptionStyle(sub)"
          @click="toggleSubscriptionFilter(sub)"
        >
          <span class="sub-item__color" aria-hidden="true" />
          <div class="sub-item__main">
            <button class="sub-item__select" :aria-label="'筛选订阅 ' + sub.topic" :aria-pressed="selectedSubFilterId === sub.id" @click.stop="toggleSubscriptionFilter(sub)">
              <span class="sub-item__top">
                <span :class="['sub-item__dot', 'sub-item__dot--' + (sub.status || 'inactive')]" role="img" :aria-label="subscriptionStatusLabel(sub)" :title="subscriptionStatusLabel(sub)" />
                <span class="sub-item__topic" :title="sub.topic">{{ sub.topic }}</span>
              </span>
            </button>
            <div class="sub-item__meta">
              <span class="sub-item__hints">
                <span class="sub-item__fmt">{{ (sub.format || 'json').toUpperCase() }}</span>
                <span class="sub-item__qos">QoS {{ sub.qos }}</span>
                <span v-if="sub.messageCount" class="sub-item__count" :title="sub.messageCount + ' 条消息'">{{ sub.messageCount }} 条</span>
              </span>
              <span class="sub-item__actions">
                <button class="sub-item__action-btn" :disabled="closing" title="复制订阅主题" @click.stop="copyText(sub.topic, '订阅主题')"><Copy :size="14" aria-hidden="true" /></button>
                <button class="sub-item__action-btn sub-item__more" :disabled="closing" title="更多订阅操作" :aria-label="'更多订阅操作 ' + sub.topic" aria-haspopup="menu" :aria-expanded="menuSubscription?.id === sub.id" :aria-controls="menuSubscription?.id === sub.id ? 'subscription-actions-menu' : undefined" @click.stop="toggleSubscriptionMenu(sub, $event)" @keydown.down.prevent="toggleSubscriptionMenu(sub, $event)"><MoreHorizontal :size="16" aria-hidden="true" /></button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <div v-if="activeConnId" class="subscription-resizer" role="separator" tabindex="0" aria-label="调整订阅栏宽度" aria-orientation="vertical" :aria-valuenow="subscriptionWidth" aria-valuemin="220" :aria-valuemax="subscriptionMaxWidth" @pointerdown="resizeSubscriptions" @keydown="resizeSubscriptionsWithKeys" />
    <div v-if="menuSubscription" id="subscription-actions-menu" ref="subscriptionMenuEl" class="subscription-menu" role="menu" :aria-label="'订阅操作 ' + menuSubscription.topic" :style="subscriptionMenuPosition" @keydown="subscriptionMenuKeydown">
      <button type="button" role="menuitem" tabindex="-1" :disabled="closing" title="复制订阅到连接" @click="runSubscriptionMenuAction(openCopySubscription)"><ArrowRightLeft :size="14" aria-hidden="true" />复制到连接…</button>
      <button type="button" role="menuitem" tabindex="-1" class="sub-item__del" :disabled="closing" title="取消订阅" @click="runSubscriptionMenuAction(confirmRemoveSub)"><X :size="14" aria-hidden="true" />取消订阅…</button>
    </div>

    <!-- ===== MAIN AREA ===== -->
    <main class="main-area" @mousemove="onDragMove" @mouseup="onDragEnd" @mouseleave="onDragEnd">
      <div v-if="connections.length === 0" class="workspace-state workspace-state--empty" role="status">
        <strong>暂无连接</strong>
        <span>新建一个 MQTT 连接以开始调试。</span>
        <button class="modal__btn modal__btn--primary workspace-state__new-connection" :disabled="closing" @click="openNewConn">新建连接</button>
      </div>
      <template v-else>
      <!-- Status Bar -->
      <header class="status-bar">
        <div class="status-bar__conn">
          <strong class="status-bar__name">{{ activeConn.name }}</strong>
          <span class="status-bar__url">{{ (activeConn.protocol || 'mqtt').replace(/:\/\/$/,'') + '://' }}{{ activeConn.host }}:{{ activeConn.port }}</span>
          <span :class="['status-bar__status', `status-bar__status--${activeConn.status}`]">
            <span class="status-bar__dot" />{{ statusLabel }}
          </span>
          <button v-if="activeConn.status === 'connected'" class="status-bar__btn status-bar__btn--disconnect" :disabled="closing" @click="disconnectMqtt()">断开</button>
          <button v-else-if="activeConn.status === 'connecting'" class="status-bar__btn status-bar__btn--disconnect" :disabled="closing" @click="stopMqttConnection()">终止</button>
          <button v-else-if="activeConn.status === 'reconnecting'" class="status-bar__btn status-bar__btn--disconnect" :disabled="closing" @click="stopMqttConnection()">停止重连</button>
          <button v-else class="status-bar__btn" :disabled="closing" @click="connectMqtt(activeConn)">连接</button>
        </div>
        <div class="status-bar__stats">
          <span>收 <strong>{{ msgCountIn }}</strong></span>
          <span>发 <strong>{{ msgCountOut }}</strong></span>
          <span>订阅 <strong>{{ connSubs.filter(s => s.status === 'active').length }}</strong></span>
        </div>
      </header>
      <nav class="workspace-tabs" aria-label="调试工作区">
        <div role="tablist" aria-label="实时视图">
          <button v-for="tab in [{id:'messages',label:'消息'},{id:'log',label:'日志'},{id:'scenarios',label:'场景测试'}]" :key="tab.id" role="tab" :aria-selected="activeTab === tab.id" :tabindex="activeTab === tab.id ? 0 : -1" @keydown="moveWorkspaceTab($event, tab.id)" @click="activeTab = tab.id">{{ tab.label }}</button>
        </div>
        <div v-if="activeTab !== 'scenarios'" class="workspace-tabs__actions">
          <button @click="toggleDensity" :aria-pressed="density === 'compact'" title="切换显示密度">{{ density === 'compact' ? '舒适' : '紧凑' }}</button>
          <button :disabled="closing" @click="openHistoryWindow(activeTab === 'log' ? 'logs' : 'messages', activeConnId)"><FileClock :size="14" aria-hidden="true" />历史记录</button>
          <button @click="activeTab === 'log' ? clearRealtimeLogs() : clearRealtimeMessages()">清空视图</button>
        </div>
      </nav>
      <div v-if="actionError" class="workspace-action-error" role="alert">{{ actionError }}</div>

      <!-- ===== Tab: Messages ===== -->
      <ScenarioPanel v-show="activeTab === 'scenarios'" :repository="scenarioRepository" :runner="scenarioRunner" :connection="activeConn" :state="scenarioState" :latest-report="latestScenarioReport" :clipboard="runtimeFacade.clipboard" :runtime-name="runtimeFacade.runtimeName" :closing="closing" />
      <template v-if="activeTab === 'messages'">
        <div style="display:flex;flex:1;min-height:0;">
          <!-- Message area -->
          <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        <div class="msg-toolbar">
          <select v-model="filterDir" aria-label="消息方向"><option value="all">全部方向</option><option value="in">接收 RX</option><option value="out">发送 TX</option></select>
          <input v-model="filterTopic" aria-label="搜索 Topic（收发均生效）" placeholder="搜索 Topic（收发均生效）">
          <span v-if="selectedSubFilter" class="msg-filter-chip" :style="subscriptionStyle(selectedSubFilter)">
            <span class="msg-filter-chip__label" :title="'接收订阅：' + selectedSubFilter.topic + '（仅筛选 RX，发送 TX 不受影响）'">接收订阅：{{ selectedSubFilter.topic }}</span>
            <button title="取消订阅过滤" @click="clearSubscriptionFilter">×</button>
          </span>

          <button class="toolbar-btn follow-button" :aria-pressed="messageFollow.following.value" @click="messageFollow.toggle">{{ messageFollow.following.value ? '↓ 跟随最新' : 'Ⅱ 已暂停跟随' }}</button>
        </div>

        <div class="message-stream">
        <div class="msg-chat" ref="chatEl" tabindex="0" aria-label="实时消息" @scroll="onMessageScroll" @wheel.passive="messageFollow.onWheel" @keydown="messageFollow.onKeydown">
          <div v-if="filteredMsgs.length === 0" class="msg-empty">没有匹配的消息</div>
          <div v-if="messageViewport.beforeHeight.value" class="message-viewport-spacer" aria-hidden="true" :style="{ height: messageViewport.beforeHeight.value + 'px' }"></div>
          <div
            v-for="msg in messageViewport.rows.value" :key="msg.id" :ref="el => messageViewport.setRowElement(msg.id, el)"
            :class="['chat-msg', `chat-msg--${msg.direction}`]"
            :style="getMessageSubStyle(msg)" :title="describeMessageSubscription(msg) + (msg.displayTruncated ? ' · 预览截断' : '')"
          >
            <div class="chat-msg__header">
              <span :class="['message-direction', 'message-direction--' + msg.direction]">{{ msg.direction === 'in' ? '↓ 接收' : '↑ 发送' }}</span>
              <time class="chat-msg__time" :title="msg.time">{{ msg.time.split(' ').at(-1) }}</time>
              <span class="chat-msg__qos">QoS {{ msg.qos ?? 0 }}</span>
              <span v-if="msg.retained" class="chat-msg__retained">保留</span>
              <span class="message-length">{{ msg.byteLength ?? messageByteLength(msg) }} B</span>
              <button class="message-copy" title="复制消息" aria-label="复制消息" @click="copyText(msg.copyPayload ?? msg.payload, '消息')"><Copy :size="14" aria-hidden="true" /></button>
            </div>
            <span class="chat-msg__topic" :title="msg.topic">{{ msg.topic }}</span>
            <button class="chat-msg__bubble" :aria-label="'查看消息 ' + msg.topic" @click="inspectMessage(msg, $event)">{{ msg.displayPayload ?? msg.payload }}</button>
            <span v-if="msg.primarySubscription" class="sr-only">{{ describeMessageSubscription(msg) }}</span>
            <span v-if="msg.displayTruncated" class="chat-msg__preview-note">预览已截断，点击消息查看详情</span>
          </div>
          <div v-if="messageViewport.afterHeight.value" class="message-viewport-spacer" aria-hidden="true" :style="{ height: messageViewport.afterHeight.value + 'px' }"></div>
        </div>
        <button v-if="messageFollow.unread.value" class="new-records" @click="messageFollow.resume">{{ messageFollow.unread.value }} 条新记录 · 回到最新</button>
        </div>
        </div>
        </div>
      </template>

      <!-- ===== Tab: Log ===== -->
      <div v-if="activeTab === 'log'" class="log-view">
        <div class="msg-toolbar">
          <input v-model="logFilter" aria-label="搜索日志" placeholder="搜索日志…">
          <span v-if="copyHint" class="copy-toast">{{ copyHint }}</span>
          <button class="toolbar-btn follow-button" :aria-pressed="logFollow.following.value" @click="logFollow.toggle">{{ logFollow.following.value ? '↓ 跟随最新' : 'Ⅱ 已暂停跟随' }}</button>
          <button v-if="logFollow.unread.value" class="toolbar-btn" @click="logFollow.resume">{{ logFollow.unread.value }} 条新记录</button>
        </div>
        <div class="msg-terminal" ref="logEl" tabindex="0" aria-label="实时日志" @scroll="logFollow.onScroll" @wheel.passive="logFollow.onWheel" @keydown="logFollow.onKeydown">
          <div v-if="filteredLogs.length === 0" class="msg-empty">暂无日志</div>
          <div v-for="l in filteredLogs" :key="l.time + l.msg" class="log-line">
            <span class="log-line__time" :title="l.time">{{ l.time.split(' ').at(-1) }}</span>
            <span :class="['log-line__level', 'log-line__level--' + l.level]">{{ {debug:'DEBUG',info:'INFO',warn:'WARN',err:'ERR',pub:'PUB'}[l.level]||l.level.toUpperCase() }}</span>
            <span class="log-line__msg">{{ l.msg }}</span>
            <button class="copy-btn copy-btn--log" title="复制日志" @click="copyText(logLineText(l), '日志')"><Copy :size="14" aria-hidden="true" /></button>
          </div>
        </div>
      </div>


      <!-- ===== Resize Handle ===== -->
      <div
        v-if="activeTab === 'messages' || activeTab === 'log'" class="resize-handle"
        role="separator" tabindex="0" aria-label="调整发送区高度" :aria-valuenow="publishHeight" aria-valuemin="180" aria-valuemax="500"
        @keydown.up.prevent="publishHeight = Math.min(500, publishHeight + 20)" @keydown.down.prevent="publishHeight = Math.max(180, publishHeight - 20)"
        aria-orientation="horizontal"
        @mousedown="onDragStart"
      >
        <span />
      </div>

      <!-- ===== Publish Bar (always visible) ===== -->
      <div v-if="activeTab === 'messages' || activeTab === 'log'" class="publish-bar" :style="{ height: publishHeight + 'px' }">
        <div class="publish-bar__topic-row">
          <label for="publish-topic">主题</label>
          <input id="publish-topic" v-model="pubTopic" placeholder="输入目标 Topic..." @keyup.enter="realPublish">
          <button class="copy-btn" title="复制发送 Topic" @click="copyText(pubTopic, '发送 Topic')"><Copy :size="14" aria-hidden="true" /></button>
          <label>QoS</label>
          <select aria-label="发布 QoS" v-model.number="pubQos"><option :value="0">0</option><option :value="1">1</option><option :value="2">2</option></select>
          <label>Retain</label>
          <select aria-label="发布 Retain" v-model.number="pubRetain"><option :value="false">否</option><option :value="true">是</option></select>
        </div>
        <div class="publish-bar__fmt-row">
          <div class="publish-bar__tool-group" role="group" aria-label="编辑格式">
            <span class="publish-bar__label">编辑格式</span>
            <button :class="['publish-bar__fmt', { active: pubFormat === 'json' }]" :aria-pressed="pubFormat === 'json'" @click="pubFormat = 'json'">JSON</button>
            <button :class="['publish-bar__fmt', { active: pubFormat === 'text' }]" :aria-pressed="pubFormat === 'text'" @click="pubFormat = 'text'">Text</button>
            <button v-if="pubFormat === 'json'" class="publish-bar__fmt" @click="prettifyJson">格式化</button>
          </div>
          <div class="publish-bar__tool-group publish-bar__encoding" role="group" aria-label="发送方式">
            <span class="publish-bar__label">发送方式</span>
            <button :class="['publish-bar__fmt', { active: pubSendMode === 'plain' }]" :aria-pressed="pubSendMode === 'plain'" title="发送 UTF-8 文本" @click="pubSendMode = 'plain'">UTF-8</button>
            <button :class="['publish-bar__fmt', { active: pubSendMode === 'hex' }]" :aria-pressed="pubSendMode === 'hex'" title="将文本转为 UTF-8 字节发送，并预览 HEX；不会解码输入的十六进制文本" @click="pubSendMode = 'hex'">HEX</button>
            <button class="copy-btn" title="复制发送内容" @click="copyText(pubPayload, '发送内容')"><Copy :size="14" aria-hidden="true" /></button>
          </div>
        </div>
        <div v-if="pubSendMode === 'hex'" class="publish-bar__hex-row">
          <span class="publish-bar__label">字节预览</span>
          <span class="publish-bar__hex-preview" :title="hexPreview.text">{{ hexPreview.text }}</span>
          <button class="copy-btn" title="复制完整 HEX" @click="copyText(fullHexText, 'HEX')"><Copy :size="14" aria-hidden="true" /></button>
        </div>
        <div v-if="publishError" class="publish-bar__error" role="alert">{{ publishError }}</div>
        <div v-if="publishedMessageHidden" class="publish-bar__notice" role="status">
          <span>已发送，当前筛选未显示</span>
          <button type="button" class="toolbar-btn" @click="showSentMessages">查看已发送</button>
        </div>
        <div class="publish-bar__payload-row">
          <PayloadEditor
            v-model="pubPayload"
            :mode="pubFormat"
            :invalid="pubFormat === 'json' && !jsonValid"
            @blur="formatJsonOnBlur"
            @change-valid="jsonValid = $event"
            @submit="realPublish"
          />
        </div>
        <footer class="publish-footer">
          <div class="publish-footer__status" aria-live="polite">
            <span>{{ encodedPublishPayload.byteLength }} B · UTF-8</span>
            <span v-if="pubFormat === 'json'" :class="['publish-bar__json-status', jsonValid ? 'publish-bar__json-status--ok' : 'publish-bar__json-status--err']">{{ jsonValid ? '✓ JSON' : '✗ JSON 无效' }}</span>
            <span v-if="copyHint" class="copy-toast" role="status">{{ copyHint }}</span>
          </div>
          <div class="publish-footer__actions">
            <span v-if="activeConn.status !== 'connected'" class="publish-footer__hint">请先连接 Broker</span>
            <kbd v-else>⌘ / Ctrl + Enter</kbd>
            <div class="publish-schedule-anchor">
              <button class="publish-bar__fmt" :class="{ active: timerRunning }" :aria-expanded="scheduleOpen || timerRunning" aria-controls="publish-schedule" @click="scheduleOpen = !scheduleOpen">{{ timerRunning ? '定时发送中' : '定时发送' }}</button>
              <div v-if="scheduleOpen || timerRunning" id="publish-schedule" class="publish-schedule" role="group" aria-label="定时发送设置" @keydown.esc.stop="scheduleOpen = false">
                <template v-if="timerRunning">
                  <span class="publish-bar__unit">下次发送</span>
                  <span class="publish-bar__timer publish-bar__timer--active">{{ timerCountdown }}s</span>
                  <button class="publish-bar__timer-btn publish-bar__timer-btn--stop" @click="toggleTimer">停止</button>
                </template>
                <template v-else>
                  <label for="publish-interval" class="publish-bar__unit">每隔</label>
                  <input id="publish-interval" aria-label="定时发送间隔（秒）" v-model.number="timerInterval" class="publish-bar__timer-input" type="number" min="1" max="999" placeholder="5">
                  <span class="publish-bar__unit">秒</span>
                  <button class="publish-bar__timer-btn" @click="toggleTimer" :disabled="!canStartTimer">▶ 开始</button>
                </template>
              </div>
            </div>
            <button class="publish-bar__send" :disabled="!canPublish" @click="realPublish">{{ publishing ? '发送中...' : '发送' }}</button>
          </div>
        </footer>
      </div>
      </template>
    </main>

    <div v-if="aboutOpen" class="modal-overlay about-overlay" @click.self="aboutOpen = false">
      <section v-modal="{ close: () => { aboutOpen = false; } }" class="about-panel desktop-about" role="dialog" aria-modal="true" aria-labelledby="mqtt-about-title">
        <header>
          <h2 id="mqtt-about-title">关于</h2>
          <button tabindex="0" type="button" class="about-panel__close" aria-label="关闭关于" title="关闭" @click="aboutOpen = false"><X :size="18" aria-hidden="true" /></button>
        </header>
        <div class="about-panel__body" tabindex="0" role="region" aria-label="产品信息">
          <div class="about-panel__identity">
            <img :src="appIcon" class="about-panel__icon" alt="" width="64" height="64">
            <div class="about-panel__product"><strong>{{ PRODUCT_NAME }}</strong><span>开发与调试小助手</span></div>
          </div>
          <dl class="about-panel__details">
            <div><dt>版本</dt><dd>{{ APP_VERSION }}</dd></div>
            <div><dt>运行环境</dt><dd class="about-panel__runtime">{{ runtimePresentation.runtimeLabel }}</dd></div>
            <div><dt>支持协议</dt><dd>MQTT 3.1.1 / 5.0</dd></div>
            <div><dt>本地存储</dt><dd>SQLite</dd></div>
            <div><dt>官方网站</dt><dd><a tabindex="0" class="about-panel__website" :href="PRODUCT_WEBSITE" target="_blank" rel="noopener noreferrer" @click="openWebsite">mqtt.ineedfull.com</a></dd></div>
          </dl>
          <p v-if="websiteError" class="about-panel__website-error" role="alert">{{ websiteError }}</p>
          <p class="about-panel__note">{{ runtimePresentation.buildLine }}<br>{{ runtimePresentation.mqttLine }}</p>
          <div v-if="updateInfo" class="about-panel__update" :class="{ 'about-panel__update--error': updateInfo.error }" :role="updateInfo.error ? 'alert' : 'status'" aria-live="polite">
            <p v-if="updateInfo.error">检测失败: {{ updateInfo.error }}</p>
            <template v-else-if="updateInfo.available">
              <strong>发现新版本 {{ updateInfo.version }}</strong>
              <p>{{ updateInfo.description }}</p>
              <button tabindex="0" v-if="(updateInfo.url || updateInfo.automatic) && !['ready', 'preparing', 'installing'].includes(updateState.phase)" type="button" class="about-panel__button update-download" :disabled="closing || updateBusy" @click="openUpdateDownload">{{ updateInfo.automatic ? '下载更新' : '下载' }}</button>
              <span v-if="updateInfo.force">（强制更新）</span>
            </template>
            <p v-else>已是最新版本</p>
          </div>
          <UpdateProgress :state="updateState" @install="runUpdateAction('install')" @cancel="runUpdateAction('cancel')" />
          <small>版权所有 © 2026 Ineed</small>
        </div>
        <footer>
          <button tabindex="0" type="button" class="about-panel__button about-panel__secondary-action" :disabled="closing || checking || updateBusy" @click="checkUpdate">{{ checking ? '检测中...' : '检查更新' }}</button>
          <button tabindex="0" type="button" class="about-panel__button" @click="aboutOpen = false">关闭</button>
        </footer>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-overlay" @click.self="closeSettings()">
      <form v-modal="{ close: closeSettings, busy: settingsSaving || storageClearing }" class="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="mqtt-settings-title" @submit.prevent="saveSettings">
        <header class="modal__header"><h3 id="mqtt-settings-title">设置</h3><button type="button" class="modal__close" aria-label="关闭设置" :disabled="settingsSaving || storageClearing" @click="closeSettings()">×</button></header>
      <!-- ===== Tab: Settings ===== -->
      <div class="settings-area">
      <fieldset class="settings-fields" :disabled="settingsSaving || storageClearing || closing">
        <div v-if="settingsError" class="settings-error" role="alert">{{ settingsError }}</div>
        <div class="settings-group">
          <div class="settings-group__title">外观</div>
          <div class="settings-row"><label for="mqtt-theme">主题</label><select id="mqtt-theme" v-model="draftTheme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div>
          <div class="settings-row"><label for="mqtt-density">显示密度</label><select id="mqtt-density" v-model="draftDensity"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></div>
          <div class="settings-row"><div><div class="settings-row__label">大字模式</div><div class="settings-row__desc">增大界面字号，适合演示或大屏</div></div><button type="button" role="switch" aria-label="大字模式" :aria-checked="settingsDraft.largeFont" :class="['toggle', { 'toggle--on': settingsDraft.largeFont }]" @click="settingsDraft.largeFont = !settingsDraft.largeFont" /></div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">日志与显示</div>
          <div class="settings-row"><div><div class="settings-row__label">日志级别</div><div class="settings-row__desc">低于此级别的日志将不显示</div></div><select aria-label="日志级别" v-model="settingsDraft.logLevel"><option value="debug">Debug - 所有</option><option value="info">Info - 常规</option><option value="warn">Warn - 警告</option><option value="error">Error - 错误</option></select></div>
          <div class="settings-row"><div><div class="settings-row__label">实时消息条目</div><div class="settings-row__desc">消息超过上限时自动保留最新内容</div></div><input aria-label="实时消息条目" v-model.number="settingsDraft.maxRealtimeMessages" type="number" min="100" max="50000" step="100" style="width:120px;"></div>
          <div class="settings-row"><div><div class="settings-row__label">实时日志条目</div><div class="settings-row__desc">日志超过上限时自动保留最新内容</div></div><input aria-label="实时日志条目" v-model.number="settingsDraft.maxLogEntries" type="number" min="100" max="50000" step="100" style="width:120px;"></div>
          <div class="settings-row"><div><div class="settings-row__label">收包日志入库</div><div class="settings-row__desc">高频订阅时建议关闭，历史消息仍会保存</div></div><button type="button" role="switch" aria-label="收包日志入库" :aria-checked="settingsDraft.persistReceiveLogs" :class="['toggle', { 'toggle--on': settingsDraft.persistReceiveLogs }]" @click="settingsDraft.persistReceiveLogs = !settingsDraft.persistReceiveLogs" /></div>
          <div class="settings-row"><div><div class="settings-row__label">接收 JSON 格式化</div><div class="settings-row__desc">按订阅格式展示 JSON，小内容自动缩进</div></div><button type="button" role="switch" aria-label="接收 JSON 格式化" :aria-checked="settingsDraft.autoFormatReceivedJson" :class="['toggle', { 'toggle--on': settingsDraft.autoFormatReceivedJson }]" @click="settingsDraft.autoFormatReceivedJson = !settingsDraft.autoFormatReceivedJson" /></div>
          <div class="settings-row"><div><div class="settings-row__label">格式化上限</div><div class="settings-row__desc">超过该字节数时跳过 JSON 自动格式化</div></div><input aria-label="格式化上限" v-model.number="settingsDraft.maxAutoFormatPayloadBytes" type="number" min="1024" max="1048576" step="1024" style="width:120px;"></div>
          <div class="settings-row"><div><div class="settings-row__label">Payload 格式化</div><div class="settings-row__desc">消息内容的自动格式化方式</div></div><select aria-label="Payload 格式化" v-model="settingsDraft.payloadFormat"><option value="auto">自动检测</option><option value="json">JSON</option><option value="text">纯文本</option><option value="hex">Hex</option></select></div>
          <div class="settings-row"><div><div class="settings-row__label">时间戳格式</div><div class="settings-row__desc">本机时区 · YYYY-MM-DD HH:mm:ss.SSS；实时列表显示时分秒和毫秒，悬停或详情查看完整日期</div></div></div>
          <div class="settings-row"><div><div class="settings-row__label">自动滚动</div><div class="settings-row__desc">新消息到达时自动滚到底部</div></div><button type="button" role="switch" aria-label="自动滚动" :aria-checked="settingsDraft.autoScroll" :class="['toggle', { 'toggle--on': settingsDraft.autoScroll }]" @click="settingsDraft.autoScroll = !settingsDraft.autoScroll" /></div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">连接默认值</div>
          <div class="settings-row"><div><div class="settings-row__label">Keep Alive (秒)</div><div class="settings-row__desc">心跳间隔，新建连接时的默认值</div></div><input aria-label="Keep Alive (秒)" v-model.number="settingsDraft.keepalive" type="number" style="width:80px;"></div>
          <div class="settings-row"><div><div class="settings-row__label">默认 QoS</div><div class="settings-row__desc">新建订阅和发布时的默认质量等级</div></div><select aria-label="默认 QoS" v-model.number="settingsDraft.defaultQos"><option :value="0">0 - 最多一次</option><option :value="1">1 - 至少一次</option><option :value="2">2 - 仅一次</option></select></div>
          <div class="settings-row"><div><div class="settings-row__label">Clean Session</div><div class="settings-row__desc">断开时是否清除服务端会话状态</div></div><select aria-label="Clean Session" v-model.number="settingsDraft.cleanSession"><option :value="true">是</option><option :value="false">否</option></select></div>
          <div class="settings-row"><div><div class="settings-row__label">自动重连</div><div class="settings-row__desc">连接断开后自动尝试重新连接</div></div><button type="button" role="switch" aria-label="自动重连" :aria-checked="settingsDraft.autoReconnect" :class="['toggle', { 'toggle--on': settingsDraft.autoReconnect }]" @click="settingsDraft.autoReconnect = !settingsDraft.autoReconnect" /></div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title settings-group__title--actions">
            <span>数据存储</span>
            <button type="button" class="storage-refresh" :disabled="closing || storageLoading || storageClearing" title="刷新存储统计" @click="refreshStorageStats">↻</button>
          </div>
          <div class="storage-stats" :class="{ 'storage-stats--loading': storageLoading }">
            <div><span>历史消息</span><strong>{{ storageStats.messageCount.toLocaleString() }}</strong></div>
            <div><span>历史日志</span><strong>{{ storageStats.logCount.toLocaleString() }}</strong></div>
            <div><span>发布历史</span><strong>{{ storageStats.publishCount.toLocaleString() }}</strong></div>
            <div><span>合计记录</span><strong>{{ storageStats.totalCount.toLocaleString() }}</strong></div>
          </div>
          <div class="storage-footprint">
            <div>
              <span>实际磁盘占用</span>
              <strong>{{ formatStorageBytes(storageStats.totalBytes) }}</strong>
              <small>数据库 {{ formatStorageBytes(storageStats.databaseBytes) }} · WAL {{ formatStorageBytes(storageStats.walBytes) }} · SHM {{ formatStorageBytes(storageStats.shmBytes) }}</small>
            </div>
            <button type="button" class="modal__btn modal__btn--danger" :disabled="closing || storageLoading || storageClearing" @click="clearHistoryStorage">{{ storageClearing ? '清理中...' : '清空历史数据' }}</button>
          </div>
          <div v-if="storageError" class="storage-error">{{ storageError }}</div>
          <div class="storage-note">只清理历史消息、历史日志和发布历史，不会删除连接、订阅和系统设置。</div>
        </div>
      </fieldset>
      </div>

        <div v-if="settingsDiscard" class="settings-discard" role="alert"><span>设置尚未保存。</span><button type="button" @click="settingsDiscard = false">继续编辑</button><button type="button" @click="closeSettings(true)">放弃修改</button></div>
        <footer class="modal__footer"><button type="button" class="modal__btn" :disabled="settingsSaving || storageClearing" @click="closeSettings()">取消</button><button type="submit" class="modal__btn modal__btn--primary" :disabled="settingsSaving || !settingsDirty">{{ settingsSaving ? '保存中…' : '保存' }}</button></footer>
      </form>
    </div>
    <aside v-if="selectedMessage" class="message-inspector" aria-label="消息详情">
      <header><strong>消息详情</strong><button class="message-inspector__close" aria-label="关闭消息详情" @click="closeInspector">×</button></header>
      <dl><dt>时间</dt><dd>{{ selectedMessage.time }}</dd><dt>方向</dt><dd>{{ selectedMessage.direction === 'in' ? '接收 RX' : '发送 TX' }}</dd><dt>主题</dt><dd>{{ selectedMessage.topic }}</dd><dt>QoS</dt><dd>{{ selectedMessage.qos }}</dd><dt>Retain</dt><dd>{{ selectedMessage.retained ? '是' : '否' }}</dd><dt>订阅</dt><dd>{{ describeMessageSubscription(selectedMessage) || '—' }}</dd></dl>
      <button class="toolbar-btn" @click="copyText(originalMessageContent(selectedMessage).text, '原始载荷')">{{ originalMessageContent(selectedMessage).label }}</button>
      <pre>{{ selectedMessage.displayPayload ?? selectedMessage.payload }}</pre>
      <p v-if="selectedMessage.displayTruncated">预览已截断 · {{ selectedMessage.byteLength }} B。复制保留完整内容。</p>
      <span role="status">{{ copyHint }}</span>
    </aside>
    <!-- ===== Subscription Modal ===== -->
    <div v-if="showSubModal" class="modal-overlay" @click.self="closeModalIfNotDragged(() => { if (!subscriptionMutating) { showSubModal = false; resetModalPos() } })">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="subscription-dialog-title" v-modal="{ close: () => { showSubModal = false; resetModalPos(); }, busy: subscriptionMutating }" style="width:500px;" :style="{ transform: 'translate(' + modalPos.x + 'px,' + modalPos.y + 'px)' }">
        <div class="modal__header" @mousedown="startModalDrag">
          <h3 id="subscription-dialog-title">添加订阅</h3>
          <button class="modal__close" aria-label="关闭添加订阅对话框" @click="!subscriptionMutating && (showSubModal = false); resetModalPos()">×</button>
        </div>
        <div class="modal__body">
          <div class="modal__field">
            <label>Topic 过滤器</label>
            <input aria-label="Topic 过滤器" v-focus v-model="newSubTopic" :disabled="subscriptionMutating" placeholder="例如：device/sensor/#" @keyup.enter="doSubscribe" style="font-family:var(--font-mono);">
            <span v-if="subscriptionWarning" :class="['modal__hint', 'modal__hint--' + subscriptionWarning.type]">{{ subscriptionWarning.message }}</span>
            <span v-if="subscriptionMutationError" class="modal__err" role="alert">{{ subscriptionMutationError }}</span>
          </div>
          <div class="modal__row">
            <div class="modal__field" style="flex:1;">
              <label>QoS</label>
              <select aria-label="订阅 QoS" v-model.number="newSubQos" style="width:100%;">
                <option :value="0">0 - 最多一次</option>
                <option :value="1">1 - 至少一次</option>
                <option :value="2">2 - 仅一次</option>
              </select>
            </div>
            <div class="modal__field" style="flex:1;">
              <label>消息格式</label>
              <select aria-label="消息格式" v-model="newSubFormat" style="width:100%;">
                <option value="json">JSON</option>
                <option value="text">Text</option>
                <option value="hex">Hex</option>
              </select>
            </div>
          </div>
        </div>
        <div class="modal__footer">
          <button class="modal__btn modal__btn--cancel" :disabled="subscriptionMutating" @click="!subscriptionMutating && (showSubModal = false)">取消</button>
          <button class="modal__btn modal__btn--primary" @click="doSubscribe" :disabled="subscriptionMutating || !newSubTopic.trim()">{{ subscriptionMutating ? '订阅中...' : '确认订阅' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== Copy Subscription Modal ===== -->
    <div v-if="subToCopy" class="modal-overlay" @click.self="closeModalIfNotDragged(() => { if (!subscriptionMutating) { subToCopy = null; resetModalPos() } })">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="copy-subscription-dialog-title" v-modal="{ close: () => { subToCopy = null; resetModalPos(); }, busy: subscriptionMutating }" style="width:420px;" :style="{ transform: 'translate(' + modalPos.x + 'px,' + modalPos.y + 'px)' }">
        <div class="modal__header" @mousedown="startModalDrag">
          <h3 id="copy-subscription-dialog-title">复制订阅</h3>
          <button class="modal__close" aria-label="关闭复制订阅对话框" @click="!subscriptionMutating && (subToCopy = null); resetModalPos()">×</button>
        </div>
        <div class="modal__body">
          <div class="modal__field">
            <label for="publish-topic">主题</label>
            <input :value="subToCopy.topic" readonly style="font-family:var(--font-mono);">
          </div>
          <div class="modal__row">
            <div class="modal__field" style="flex:1;">
              <label>QoS</label>
              <input :value="subToCopy.qos" readonly>
            </div>
            <div class="modal__field" style="flex:1;">
              <label>格式</label>
              <input :value="subToCopy.format || 'json'" readonly>
            </div>
          </div>
          <div class="modal__field">
            <label>目标连接</label>
            <select aria-label="目标连接" v-focus v-model="copySubTargetConnId" :disabled="subscriptionMutating">
              <option value="" disabled>请选择连接</option>
              <option v-for="conn in copySubTargets" :key="conn.id" :value="conn.id">{{ conn.name }} - {{ conn.host }}:{{ conn.port }}</option>
            </select>
            <span v-if="subscriptionMutationError" class="modal__err" role="alert">{{ subscriptionMutationError }}</span>
          </div>
        </div>
        <div class="modal__footer">
          <button class="modal__btn modal__btn--cancel" :disabled="subscriptionMutating" @click="!subscriptionMutating && (subToCopy = null)">取消</button>
          <button class="modal__btn modal__btn--primary" :disabled="subscriptionMutating || !copySubTargetConnId" @click="copySubscriptionToConnection">{{ subscriptionMutating ? '复制中...' : '复制' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== New Connection Modal ===== -->
    <div v-if="showNewConn" class="modal-overlay" @click.self="closeModalIfNotDragged(() => { if (!connectionSaving) { showNewConn = false; resetModalPos() } })">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title" v-modal="{ close: () => { showNewConn = false; resetModalPos(); }, busy: connectionSaving }" :style="{ transform: 'translate(' + modalPos.x + 'px,' + modalPos.y + 'px)' }">
        <div class="modal__header" @mousedown="startModalDrag">
          <h3 id="connection-dialog-title">{{ modalTitle }}</h3>
          <button class="modal__close" aria-label="关闭连接对话框" @click="!connectionSaving && (showNewConn = false)">×</button>
        </div>
        <div class="modal__body">
          <div class="modal__field">
            <label>连接名称 <span class="modal__required">*</span></label>
            <input aria-label="连接名称" v-focus v-model="newConn.name" :disabled="connectionSaving" :class="{ 'modal__input--err': connErrors.name }" placeholder="例如：本地开发 Broker" @keyup.enter="saveConnection" @blur="validate('name')" @input="connErrors.name = ''">
            <span v-if="connErrors.name" class="modal__err">{{ connErrors.name }}</span>
            <span v-if="connectionSaveError" class="modal__err" role="alert">{{ connectionSaveError }}</span>
          </div>
          <div class="modal__row">
            <div class="modal__field" style="width:115px;flex-shrink:0;">
              <label>协议</label>
              <select :disabled="connectionSaving" aria-label="协议" v-model="newConn.protocol" @change="onProtocolChange">
                <option v-for="p in protocolOptions" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
            <div class="modal__field" style="flex:1;">
              <label>主机地址 <span class="modal__required">*</span></label>
              <input :disabled="connectionSaving" aria-label="主机地址" v-model="newConn.host" :class="{ 'modal__input--err': connErrors.host }" placeholder="localhost" @blur="validate('host')" @input="connErrors.host = ''">
              <span v-if="connErrors.host" class="modal__err">{{ connErrors.host }}</span>
            </div>
            <div class="modal__field" style="width:100px;flex-shrink:0;">
              <label>端口 <span class="modal__required">*</span></label>
              <input :disabled="connectionSaving" aria-label="端口" v-model.number="newConn.port" :class="{ 'modal__input--err': connErrors.port }" type="number" placeholder="1883" @blur="validate('port')" @input="connErrors.port = ''">
              <span v-if="connErrors.port" class="modal__err">{{ connErrors.port }}</span>
            </div>
          </div>
          <div v-if="['ws://', 'wss://'].includes(newConn.protocol)" class="modal__field">
            <label for="connection-ws-path">WebSocket 路径</label>
            <input id="connection-ws-path" aria-label="WebSocket 路径" v-model="newConn.path" :disabled="connectionSaving" :class="{ 'modal__input--err': connErrors.path }" placeholder="/mqtt（留空使用此路径）" @blur="validate('path')" @input="connErrors.path = ''">
            <span v-if="connErrors.path" class="modal__err">{{ connErrors.path }}</span>
          </div>
          <div class="modal__row">
            <div class="modal__field" style="flex:1;">
              <label>Client ID</label>
              <input :disabled="connectionSaving" aria-label="Client ID" v-model="newConn.clientId" placeholder="自动生成">
            </div>
            <div class="modal__field" style="flex:1;">
              <label>用户名</label>
              <input :disabled="connectionSaving" aria-label="用户名" v-model="newConn.username" placeholder="选填">
            </div>
            <div class="modal__field" style="flex:1;">
              <label>密码</label>
              <input :disabled="connectionSaving" aria-label="密码" v-model="newConn.password" type="password" placeholder="选填">
            </div>
          </div>
          <div class="modal__row">
            <div class="modal__field" style="flex:0 0 160px;">
              <label>Keep Alive (秒)</label>
              <input :disabled="connectionSaving" aria-label="Keep Alive (秒)" v-model.number="newConn.keepalive" :class="{ 'modal__input--err': connErrors.keepalive }" type="number" min="10" max="3600" placeholder="60" @blur="validate('keepalive')" @input="connErrors.keepalive = ''">
              <span v-if="connErrors.keepalive" class="modal__err">{{ connErrors.keepalive }}</span>
            </div>
            <div class="modal__field" style="flex:1;" />
          </div>
        </div>
        <div class="modal__footer">
          <button class="modal__btn modal__btn--cancel" :disabled="connectionSaving" @click="!connectionSaving && (showNewConn = false)">取消</button>
          <button class="modal__btn modal__btn--primary" :disabled="connectionSaving" @click="saveConnection">{{ connectionSaving ? '保存中...' : (editingConnId ? '保存' : '创建连接') }}</button>
        </div>
      </div>
    </div>    <!-- ===== Delete Subscription Modal ===== -->
    <div v-if="subToDel" class="modal-overlay" @click.self="closeModalIfNotDragged(() => { if (!subscriptionMutating) { subToDel = null; resetModalPos() } })">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="remove-subscription-dialog-title" v-modal="{ close: () => { subToDel = null; resetModalPos(); }, busy: subscriptionMutating }" style="width:400px;" :style="{ transform: 'translate(' + modalPos.x + 'px,' + modalPos.y + 'px)' }">
        <div class="modal__header" @mousedown="startModalDrag">
          <h3 id="remove-subscription-dialog-title">取消订阅</h3>
          <button v-focus class="modal__close" aria-label="关闭取消订阅对话框" :disabled="subscriptionMutating" @click="!subscriptionMutating && (subToDel = null)">×</button>
        </div>
        <div class="modal__body">
          <p style="margin:0;color:var(--chrome-text);">确定要取消以下订阅吗？</p>
          <p style="margin:8px 0;font-family:var(--font-mono);font-size:var(--font-size);font-weight:700;color:var(--topic-color);">{{ subToDel.topic }}</p>
          <p style="margin:0;font-size:var(--font-size-small);color:var(--chrome-text-muted);">QoS {{ subToDel.qos }}</p>
          <p v-if="subscriptionMutationError" class="modal__err" role="alert">{{ subscriptionMutationError }}</p>
        </div>
        <div class="modal__footer">
          <button class="modal__btn modal__btn--cancel" :disabled="subscriptionMutating" @click="!subscriptionMutating && (subToDel = null)">取消</button>
          <button class="modal__btn modal__btn--primary" :disabled="subscriptionMutating" @click="removeSubscription" style="background:var(--error);">{{ subscriptionMutating ? '取消中...' : '确认取消' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== Delete Confirmation Modal ===== -->
    <div v-if="delTarget" class="modal-overlay" @click.self="closeModalIfNotDragged(() => { if (!deletingConnectionId) { delTarget = null; resetModalPos() } })">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-connection-dialog-title" v-modal="{ close: () => { delTarget = null; resetModalPos(); }, busy: deletingConnectionId }" style="width:400px;" :style="{ transform: 'translate(' + modalPos.x + 'px,' + modalPos.y + 'px)' }">
        <div class="modal__header" @mousedown="startModalDrag">
          <h3 id="delete-connection-dialog-title">删除连接</h3>
          <button v-focus class="modal__close" aria-label="关闭删除连接对话框" :disabled="deletingConnectionId" @click="!deletingConnectionId && (delTarget = null)">×</button>
        </div>
        <div class="modal__body">
          <p style="margin:0;color:var(--error);font-weight:700;">此操作不可撤销</p>
          <p style="margin:8px 0 0;color:var(--chrome-text-muted);font-size:var(--font-size-control);">确定要删除连接 <b>{{ delTarget.name }}</b> 吗？</p>
          <p v-if="connectionMutationError" class="modal__err" role="alert">{{ connectionMutationError }}</p>
        </div>
        <div class="modal__footer">
          <button class="modal__btn modal__btn--cancel" :disabled="deletingConnectionId" @click="!deletingConnectionId && (delTarget = null)">取消</button>
          <button class="modal__btn modal__btn--danger" :disabled="deletingConnectionId" @click="confirmDelete">{{ deletingConnectionId ? '删除中...' : '确认删除' }}</button>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>
