<script setup>
import { computed, ref, watch } from 'vue';
const props = defineProps({ state: { type: Object, required: true } });
defineEmits(['install', 'cancel']);
const confirming = ref(false);
watch(() => props.state.phase, () => { confirming.value = false; });
const labels = { downloading: '正在下载更新', verifying: '正在校验更新', ready: '更新已下载并通过校验',
  preparing: '正在断开连接并保存数据', installing: '正在安装更新，请稍候' };
const label = computed(() => labels[props.state.phase] || '');
const amount = value => `${((Number(value) || 0) / 1_048_576).toFixed(1)} MiB`;
</script>
<template>
  <div class="update-progress" aria-live="polite">
    <p v-if="label" role="status">{{ label }}</p>
    <template v-if="state.phase === 'downloading'">
      <progress v-if="state.total > 0" :value="state.transferred" :max="state.total" aria-label="更新下载进度" />
      <progress v-else aria-label="更新下载进度" />
      <small>{{ amount(state.transferred) }}<template v-if="state.total > 0"> / {{ amount(state.total) }}</template></small>
      <button v-if="state.canCancel" type="button" class="about-panel__button" @click="$emit('cancel')">取消下载</button>
    </template>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <template v-if="state.phase === 'ready'">
      <button v-if="!confirming" type="button" class="about-panel__button update-restart" @click="confirming = true">重启并安装</button>
      <div v-else class="update-confirm" role="group" aria-label="确认安装更新">
        <p>MQTT 连接将断开。保存数据后重启并安装更新。</p>
        <button type="button" class="about-panel__button update-confirm-install" @click="$emit('install')">确认重启并安装</button>
        <button type="button" class="about-panel__button" @click="confirming = false">稍后</button>
      </div>
    </template>
  </div>
</template>
<style scoped>
.update-progress { display: grid; gap: 8px; min-width: 0; }
.update-progress p { margin: 0; overflow-wrap: anywhere; }
.update-progress progress { width: 100%; accent-color: var(--accent); }
.update-progress small { font-size: var(--font-size-small); }
.update-confirm { display: flex; flex-wrap: wrap; gap: 8px; }
.update-confirm p { flex-basis: 100%; }
</style>
