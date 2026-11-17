<script setup>
import { X } from 'lucide-vue-next';
import { APP_VERSION, PRODUCT_NAME, PRODUCT_WEBSITE } from '../product.js';
import appIcon from '../assets/ineed-mqtt.svg';
import { modalDirective as vModal } from '../workspace/modalDirective.js';
import UpdateProgress from './UpdateProgress.vue';
defineProps({
  runtimePresentation: { type: Object, required: true },
  websiteError: String,
  updateInfo: Object,
  updateState: { type: Object, required: true },
  closing: Boolean,
  updateBusy: Boolean,
  checking: Boolean,
});
const emit = defineEmits(['close', 'open-website', 'check-update', 'download-update', 'update-action']);
const close = () => emit('close');

</script>

<template>
  <div class="modal-overlay about-overlay" @click.self="close()">
    <section v-modal="{ close: () => { close(); } }" class="about-panel desktop-about" role="dialog" aria-modal="true" aria-labelledby="mqtt-about-title">
      <header>
        <h2 id="mqtt-about-title">关于</h2>
        <button tabindex="0" type="button" class="about-panel__close" aria-label="关闭关于" title="关闭" @click="close()"><X :size="18" aria-hidden="true" /></button>
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
          <div><dt>官方网站</dt><dd><a tabindex="0" class="about-panel__website" :href="PRODUCT_WEBSITE" target="_blank" rel="noopener noreferrer" @click="emit('open-website', $event)">mqtt.ineedfull.com</a></dd></div>
        </dl>
        <p v-if="websiteError" class="about-panel__website-error" role="alert">{{ websiteError }}</p>
        <p class="about-panel__note">{{ runtimePresentation.buildLine }}<br>{{ runtimePresentation.mqttLine }}</p>
        <div v-if="updateInfo" class="about-panel__update" :class="{ 'about-panel__update--error': updateInfo.error }" :role="updateInfo.error ? 'alert' : 'status'" aria-live="polite">
          <p v-if="updateInfo.error">检测失败: {{ updateInfo.error }}</p>
          <template v-else-if="updateInfo.available">
            <strong>发现新版本 {{ updateInfo.version }}</strong>
            <p>{{ updateInfo.description }}</p>
            <button tabindex="0" v-if="(updateInfo.url || updateInfo.automatic) && !['ready', 'preparing', 'installing'].includes(updateState.phase)" type="button" class="about-panel__button update-download" :disabled="closing || updateBusy" @click="emit('download-update')">{{ updateInfo.automatic ? '下载更新' : '下载' }}</button>
            <span v-if="updateInfo.force">（强制更新）</span>
          </template>
          <p v-else>已是最新版本</p>
        </div>
        <UpdateProgress :state="updateState" @install="emit('update-action', 'install')" @cancel="emit('update-action', 'cancel')" />
        <small>版权所有 © 2026 Ineed</small>
      </div>
      <footer>
        <button tabindex="0" type="button" class="about-panel__button about-panel__secondary-action" :disabled="closing || checking || updateBusy" @click="emit('check-update')">{{ checking ? '检测中...' : '检查更新' }}</button>
        <button tabindex="0" type="button" class="about-panel__button" @click="close()">关闭</button>
      </footer>
    </section>
  </div>
</template>
