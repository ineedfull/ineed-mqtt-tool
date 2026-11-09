<script setup>
import { computed } from 'vue';
import HistoryWindow from './layouts/HistoryWindow.vue';
import MqttToolShell from './layouts/MqttToolShell.vue';
import './styles/typography.css';
import './styles/select-controls.css';

const view = computed(() => new URLSearchParams(window.location.search).get('history'));
</script>

<template>
  <HistoryWindow v-if="view" />
  <MqttToolShell v-else />
</template>
