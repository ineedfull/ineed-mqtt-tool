<script setup>
import { modalDirective as vModal } from '../workspace/modalDirective.js';
import { protocolOptions } from '@ineed-mqtt-tool/domain/connection-model';
defineProps({
  connectionSaving: Boolean,
  modalPos: { type: Object, required: true },
  modalTitle: String,
  connectionSaveError: String,
  editingConnId: String,
});
const newConn = defineModel('draft', { type: Object, required: true });
const connErrors = defineModel('errors', { type: Object, required: true });
const vFocus = { mounted: element => { element.dataset.autofocus = ''; } };
const emit = defineEmits(['outside-click', 'close', 'close-and-reset', 'drag-start', 'save', 'validate', 'protocol-change']);
const saveConnection = () => emit('save');
const validate = field => emit('validate', field);
const onProtocolChange = event => emit('protocol-change', event);
const startModalDrag = event => emit('drag-start', event);

</script>

<template>
  <div class="modal-overlay" @click.self="emit('outside-click')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title" v-modal="{ close: () => { emit('close-and-reset'); }, busy: connectionSaving }" :style="{ transform: 'translate(' + modalPos.x + 'px,' + modalPos.y + 'px)' }">
      <div class="modal__header" @mousedown="startModalDrag">
        <h3 id="connection-dialog-title">{{ modalTitle }}</h3>
        <button class="modal__close" aria-label="关闭连接对话框" @click="!connectionSaving && (emit('close'))">×</button>
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
        <button class="modal__btn modal__btn--cancel" :disabled="connectionSaving" @click="!connectionSaving && (emit('close'))">取消</button>
        <button class="modal__btn modal__btn--primary" :disabled="connectionSaving" @click="saveConnection">{{ connectionSaving ? '保存中...' : (editingConnId ? '保存' : '创建连接') }}</button>
      </div>
    </div>
  </div>
</template>
