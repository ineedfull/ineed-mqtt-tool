<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  normalizeScenario,
  prepareScenario,
  scenarioExample,
  SCENARIO_LIMITS,
} from "@ineed-mqtt-tool/domain";
import { copyText } from "../workspace/clipboard.js";
import { formatTimestamp } from "../workspace/timeFormat.js";
import "../styles/scenarios.css";
const props = defineProps({
  repository: Object,
  runner: Object,
  connection: Object,
  state: Number,
  latestReport: Object,
  closing: Boolean,
  clipboard: Object,
  runtimeName: String,
});
const scenarios = ref([]);
const reports = ref([]);
const selectedScenarioId = ref("");
const draft = ref(scenarioExample(globalThis.crypto.randomUUID()));
const variablesText = ref(JSON.stringify(draft.value.variables, null, 2));
const error = ref("");
const notice = ref("");
const loading = ref(true);
const saving = ref(false);
const confirmingDelete = ref(false);
const exportText = ref("");
const exportFilename = ref("");
const exportAreaRef = ref(null);
const importText = ref("");
const importPreview = ref(null);
const selectedReport = ref(null);
const busy = computed(() => {
  void props.state;
  return props.runner.busy;
});
const report = computed(
  () => selectedReport.value || props.latestReport || reports.value[0],
);
const statusLabels = {
  pass: "通过",
  fail: "失败",
  timeout: "超时",
  stopped: "已停止",
  "connection-loss": "连接中断",
  running: "执行中",
};
const cleanupLabel = computed(() => {
  if (report.value?.cleanup === "pending") return "等待确认";
  if (report.value?.cleanup === "retry-on-connect") return "下次连接重试";
  return "已释放或交由重连清理";
});
function refreshLibrarySnapshot() {
  scenarios.value = props.repository.scenarios;
  reports.value = props.repository.reports;
}
function loadScenarioDraft(value) {
  draft.value = JSON.parse(JSON.stringify(value));
  variablesText.value = JSON.stringify(value.variables, null, 2);
  confirmingDelete.value = false;
}
function selectScenario() {
  const item = scenarios.value.find((s) => s.id === selectedScenarioId.value);
  if (item) loadScenarioDraft(item);
}
function createScenarioDraft() {
  selectedScenarioId.value = "";
  loadScenarioDraft(scenarioExample(globalThis.crypto.randomUUID()));
  notice.value = "新场景草稿";
}
function readScenarioDraft() {
  if (draft.value.assertions.some((rule) => rule.invalidExpected))
    throw new Error("equals 期望值必须是有效 JSON 标量");
  return normalizeScenario({
    ...draft.value,
    variables: JSON.parse(variablesText.value),
  });
}
async function runLibraryAction(work) {
  if (saving.value || props.closing) return;
  error.value = "";
  notice.value = "";
  saving.value = true;
  try {
    await work();
    refreshLibrarySnapshot();
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}
async function saveScenario() {
  await runLibraryAction(async () => {
    const candidate = readScenarioDraft();
    prepareScenario(candidate, "validation-request");
    const original = scenarios.value.find((s) => s.id === candidate.id);
    if (original && JSON.stringify(original) !== JSON.stringify(candidate))
      candidate.version = original.version + 1;
    await props.repository.save(candidate);
    selectedScenarioId.value = candidate.id;
    loadScenarioDraft(candidate);
    notice.value = "场景已保存";
  });
}
async function removeScenario() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  await runLibraryAction(async () => {
    await props.repository.remove(draft.value.id);
    createScenarioDraft();
    notice.value = "场景已删除，历史报告保留";
  });
}
function previewImport() {
  error.value = "";
  try {
    importPreview.value = props.repository.previewImport(importText.value);
  } catch (e) {
    importPreview.value = null;
    error.value = e.message;
  }
}
async function confirmImport() {
  await runLibraryAction(async () => {
    await props.repository.importScenarios(importPreview.value);
    importPreview.value = null;
    importText.value = "";
    notice.value = "场景已导入为独立副本";
  });
}
// New text/file selections and unmount invalidate pending file reads.
let importRevision = 0;
let disposed = false;
async function readImportFile(event) {
  const picker = event.target;
  const file = picker.files?.[0];
  if (!file) return;
  const revision = ++importRevision;
  error.value = "";
  importPreview.value = null;
  try {
    if (file.size > SCENARIO_LIMITS.libraryBytes)
      throw new Error("导入文件不能超过2MiB");
    const text = await file.text();
    if (disposed || revision !== importRevision) return;
    importText.value = text;
    previewImport();
  } catch (reason) {
    if (!disposed && revision === importRevision)
      error.value = reason?.message || "场景文件读取失败";
  } finally {
    picker.value = "";
  }
}
function downloadJson(text, filename) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showExport(text, filename) {
  exportText.value = text;
  exportFilename.value = filename;
  nextTick(() => {
    exportAreaRef.value?.focus();
    exportAreaRef.value?.select();
  });
}
function exportLibrary() {
  showExport(props.repository.exportScenarios(), "mqtt-scenarios.json");
}
function exportReport() {
  if (report.value)
    showExport(
      JSON.stringify(report.value, null, 2),
      `mqtt-scenario-${report.value.runId}.json`,
    );
}
async function copyExport() {
  const result = await copyText(exportText.value, props.clipboard);
  if (result.ok) {
    notice.value = "JSON 已复制，可保存到文件或粘贴导入";
    error.value = "";
  } else error.value = "复制失败，请在导出内容框中手动复制：" + result.error;
}
async function runScenario() {
  error.value = "";
  notice.value = "";
  selectedReport.value = null;
  try {
    await props.runner.start(readScenarioDraft(), props.connection);
  } catch (e) {
    error.value = e.message;
  }
}
function updateExpectedValue(rule, event) {
  rule.expectedText = event.target.value;
  try {
    rule.expected = JSON.parse(event.target.value);
    rule.invalidExpected = false;
    error.value = "";
  } catch {
    rule.invalidExpected = true;
    error.value = 'equals 期望值必须是 JSON 标量，如 "ok"、25、true';
  }
}
function addAssertion() {
  draft.value.assertions.push({
    path: "status",
    operator: "equals",
    expected: "ok",
  });
}
function changeAssertionOperator(rule) {
  rule.invalidExpected = false;
  delete rule.expectedText;
  if (rule.operator === "range") {
    rule.min = 0;
    rule.max = 100;
  } else rule.expected = rule.operator === "type" ? "number" : "ok";
}
watch(
  importText,
  () => {
    importRevision++;
    importPreview.value = null;
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  disposed = true;
  importRevision++;
});
watch(() => props.state, refreshLibrarySnapshot);
onMounted(async () => {
  try {
    await props.repository.load();
    refreshLibrarySnapshot();
    if (scenarios.value.length) {
      selectedScenarioId.value = scenarios.value[0].id;
      selectScenario();
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>
<template>
  <section
    class="scenario-panel"
    aria-label="设备消息场景测试"
    :aria-busy="loading || saving"
  >
    <header class="scenario-panel__header">
      <div>
        <h2>设备消息场景测试</h2>
        <p>
          当前连接：{{ connection?.name || "未选择" }} ·
          先确认响应订阅，再发送指令并校验业务响应。
        </p>
      </div>
      <div class="scenario-actions">
        <button
          :disabled="loading || saving || closing"
          @click="createScenarioDraft"
        >
          新建场景</button
        ><button
          data-action="export-scenarios"
          :disabled="!scenarios.length"
          @click="exportLibrary"
        >
          导出场景
        </button>
      </div>
    </header>
    <p v-if="error" role="alert" class="scenario-error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <section v-if="exportText" class="scenario-export" aria-label="导出 JSON">
      <h3>导出 JSON · {{ exportFilename }}</h3>
      <p>
        可复制下面的完整 JSON；场景 JSON
        可粘贴到「导入场景」。连接凭证不包含在导出中，业务载荷和变量仍会保留。
      </p>
      <textarea
        ref="exportAreaRef"
        :value="exportText"
        readonly
        aria-label="导出 JSON 内容"
        rows="6"
        spellcheck="false"
      />
      <div class="scenario-actions">
        <button data-action="copy-export" @click="copyExport">复制 JSON</button
        ><button
          v-if="runtimeName !== 'tauri'"
          data-action="download-export"
          @click="downloadJson(exportText, exportFilename)"
        >
          下载 JSON 文件</button
        ><button @click="exportText = ''">关闭导出</button>
      </div>
    </section>
    <div class="scenario-grid">
      <div class="scenario-editor">
        <label
          >已保存场景<select
            v-model="selectedScenarioId"
            aria-label="已保存场景"
            :disabled="loading || saving"
            @change="selectScenario"
          >
            <option value="">新场景草稿</option>
            <option v-for="item in scenarios" :key="item.id" :value="item.id">
              {{ item.name }} · v{{ item.version }}
            </option>
          </select></label
        >
        <fieldset :disabled="loading || saving || closing">
          <legend>场景配置 · v{{ draft.version }}</legend>
          <label
            >场景名称<input
              v-model="draft.name"
              aria-label="场景名称"
              maxlength="128"
          /></label>
          <label
            >发布主题<input
              v-model="draft.publishTopic"
              aria-label="发布主题"
              spellcheck="false"
          /></label>
          <label
            >响应主题<input
              v-model="draft.responseTopic"
              aria-label="响应主题"
              spellcheck="false"
            /><small
              >具体主题；可使用 &#123;&#123;device&#125;&#125; 或
              &#123;&#123;requestId&#125;&#125;，不支持通配符。</small
            ></label
          >
          <label
            >变量（JSON 字符串对象）<textarea
              v-model="variablesText"
              aria-label="场景变量"
              rows="3"
              spellcheck="false"
            />
          </label>
          <label
            >请求载荷模板<textarea
              v-model="draft.payloadTemplate"
              aria-label="请求载荷模板"
              rows="4"
              spellcheck="false"
            /><small
              >变量放在 JSON 字符串内；关联字段始终写入本轮唯一
              requestId。</small
            ></label
          >
          <div class="scenario-fields">
            <label
              >请求/响应关联路径<input
                v-model="draft.correlationPath"
                aria-label="关联字段路径"
                placeholder="data.requestId" /></label
            ><label
              >超时（ms）<input
                v-model.number="draft.timeoutMs"
                aria-label="场景超时"
                type="number"
                min="50"
                max="300000" /></label
            ><label
              >发布 QoS<select v-model.number="draft.qos" aria-label="场景 QoS">
                <option :value="0">0</option>
                <option :value="1">1</option>
                <option :value="2">2</option>
              </select></label
            >
          </div>
          <p class="scenario-note">
            关联只支持点分隔 JSON 字段。保留响应、旧请求、无效 JSON
            不作为成功证据；QoS ACK 不代表业务通过。
          </p>
          <fieldset class="scenario-assertions">
            <legend>业务断言（全部满足才通过）</legend>
            <div
              v-for="(rule, index) in draft.assertions"
              :key="index"
              class="scenario-rule"
            >
              <label
                >字段路径<input
                  v-model="rule.path"
                  :aria-label="`断言 ${index + 1} 路径`"
              /></label>
              <label
                >检查<select
                  v-model="rule.operator"
                  :aria-label="`断言 ${index + 1} 类型`"
                  @change="changeAssertionOperator(rule)"
                >
                  <option value="equals">等于</option>
                  <option value="type">JSON 类型</option>
                  <option value="range">数值范围</option>
                </select></label
              >
              <label v-if="rule.operator === 'equals'"
                >期望（JSON）<input
                  :value="rule.expectedText ?? JSON.stringify(rule.expected)"
                  :aria-label="`断言 ${index + 1} 期望`"
                  @input="updateExpectedValue(rule, $event)"
              /></label>
              <label v-else-if="rule.operator === 'type'"
                >期望类型<select
                  v-model="rule.expected"
                  :aria-label="`断言 ${index + 1} 期望类型`"
                >
                  <option
                    v-for="type in [
                      'string',
                      'number',
                      'boolean',
                      'object',
                      'array',
                      'null',
                    ]"
                    :key="type"
                  >
                    {{ type }}
                  </option>
                </select></label
              >
              <template v-else
                ><label
                  >最小<input
                    v-model.number="rule.min"
                    type="number"
                    :aria-label="`断言 ${index + 1} 最小值`" /></label
                ><label
                  >最大<input
                    v-model.number="rule.max"
                    type="number"
                    :aria-label="`断言 ${index + 1} 最大值`" /></label
              ></template>
              <button
                :disabled="draft.assertions.length === 1"
                :aria-label="`移除断言 ${index + 1}`"
                @click="draft.assertions.splice(index, 1)"
              >
                移除
              </button>
            </div>
            <button
              :disabled="draft.assertions.length >= 32"
              @click="addAssertion"
            >
              添加断言
            </button>
          </fieldset>
          <div class="scenario-actions">
            <button data-action="save-scenario" @click="saveScenario">
              {{ saving ? "保存中…" : "保存场景" }}</button
            ><button :disabled="!selectedScenarioId" @click="removeScenario">
              {{ confirmingDelete ? "确认删除场景" : "删除场景" }}
            </button>
          </div>
        </fieldset>
        <details class="scenario-import">
          <summary>导入场景</summary>
          <p>
            先预览，再确认保存为独立副本。业务载荷和变量会随场景导出，请检查其中的敏感信息。
          </p>
          <input
            type="file"
            accept=".json,application/json"
            aria-label="选择场景文件"
            @change="readImportFile"
          /><label
            >导入 JSON<textarea
              v-model="importText"
              aria-label="导入场景 JSON"
              rows="5"
            /></label
          ><button
            data-action="preview-import"
            :disabled="saving || loading"
            @click="previewImport"
          >
            预览导入
          </button>
          <div v-if="importPreview">
            <p>待导入 {{ importPreview.length }} 个场景</p>
            <ul>
              <li v-for="(item, index) in importPreview" :key="index">
                {{ item.name }} · v{{ item.version }}
              </li>
            </ul>
            <button
              data-action="confirm-import"
              :disabled="saving || closing"
              @click="confirmImport"
            >
              确认导入
            </button>
          </div>
        </details>
      </div>
      <aside class="scenario-results" aria-label="场景执行结果">
        <div class="scenario-actions">
          <button
            data-action="run-scenario"
            :disabled="
              loading ||
              saving ||
              closing ||
              busy ||
              connection?.status !== 'connected'
            "
            @click="runScenario"
          >
            执行当前草稿</button
          ><button :disabled="!busy" @click="runner.stop()">停止</button>
        </div>
        <p class="scenario-note">停止会结束等待，已发布的指令无法撤回。</p>
        <p v-if="busy" role="status">
          执行中或等待订阅清理，订阅编辑将在本轮释放后继续。
        </p>
        <p v-if="connection?.status !== 'connected'">
          请先连接 MQTT Broker，再执行场景。
        </p>
        <label v-if="reports.length"
          >历史报告<select
            :value="selectedReport?.runId || ''"
            aria-label="场景历史报告"
            @change="
              selectedReport =
                reports.find((r) => r.runId === $event.target.value) || null
            "
          >
            <option value="">最新结果</option>
            <option
              v-for="item in reports"
              :key="item.runId"
              :value="item.runId"
            >
              {{ formatTimestamp(item.startedAt) }} · {{ item.scenario.name }} ·
              {{ statusLabels[item.status] }}
            </option>
          </select></label
        >
        <template v-if="report"
          ><h3 aria-live="polite">
            {{ statusLabels[report.status] || report.status }} ·
            {{ report.scenario.name }}
          </h3>
          <p>{{ report.reason }}</p>
          <dl>
            <dt>开始时间</dt>
            <dd>{{ formatTimestamp(report.startedAt) }}</dd>
            <dt>结束时间</dt>
            <dd>{{ formatTimestamp(report.finishedAt) }}</dd>
            <dt>本轮请求 ID</dt>
            <dd>
              <code>{{ report.requestId }}</code>
            </dd>
            <dt>订阅清理</dt>
            <dd>{{ cleanupLabel }}</dd>
          </dl>
          <p v-if="report.persistenceError" role="alert">
            报告保存失败：{{ report.persistenceError }}
          </p>
          <p v-if="report.cleanupError" role="alert">
            {{ report.cleanupError }}
          </p>
          <ul>
            <li v-for="(rule, index) in report.assertions" :key="index">
              {{ rule.passed ? "通过" : "失败" }} · {{ rule.path }} ·
              {{ rule.operator }} · 实际
              {{ rule.missing ? "缺失" : JSON.stringify(rule.actual) }}
            </li>
          </ul>
          <button @click="exportReport">导出结果 JSON</button>
          <details open>
            <summary>原始收发证据与场景快照</summary>
            <pre>{{ JSON.stringify(report, null, 2) }}</pre>
          </details></template
        >
        <p v-else>
          尚无执行结果。报告保留最近30次执行，包含当时的场景快照、原文与断言。
        </p>
      </aside>
    </div>
  </section>
</template>
