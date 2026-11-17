<script setup>
import { modalDirective as vModal } from '../workspace/modalDirective.js';
import { formatStorageBytes } from '../workspace/storageStats.js';
defineProps({
  settingsSaving: Boolean, storageClearing: Boolean, closing: Boolean,
  settingsError: String, settingsDirty: Boolean, storageLoading: Boolean,
  storageStats: { type: Object, required: true }, storageError: String,
});
// The shell owns drafts, persistence, and discard confirmation across this view.
const settingsDraft = defineModel('draft', { type: Object, required: true });
const draftTheme = defineModel('theme', { type: String, required: true });
const draftDensity = defineModel('density', { type: String, required: true });
const settingsDiscard = defineModel('discard', { type: Boolean, required: true });
const emit = defineEmits(['close', 'save', 'refresh-storage', 'clear-history']);
const closeSettings = (discard = false) => emit('close', discard);
const saveSettings = () => emit('save');
const refreshStorageStats = () => emit('refresh-storage');
const clearHistoryStorage = () => emit('clear-history');

</script>

<template>
  <div class="modal-overlay" @click.self="closeSettings()">
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
</template>
