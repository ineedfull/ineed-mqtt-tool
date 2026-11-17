'use strict';

// Channel allowlists and byte limits shared by handlers and window authorization.


const IPC_MAX_BATCH_ITEMS = 1_000;

const IPC_MAX_ITEM_BYTES = 1_048_576;

const IPC_MAX_TOTAL_BYTES = 8_388_608;

const IPC_CLIPBOARD_MAX_BYTES = 33_554_432;

const IPC_CHANNELS = Object.freeze({
  dbGetConnections: 'db:get-connections',
  dbSaveConnection: 'db:save-connection',
  dbDeleteConnection: 'db:delete-connection',
  dbGetMessageCounts: 'db:get-message-counts',
  dbGetSubscriptions: 'db:get-subscriptions',
  dbAddSubscription: 'db:add-subscription',
  dbRemoveSubscription: 'db:remove-subscription',
  dbSaveMessages: 'db:save-messages',
  dbSaveLogs: 'db:save-logs',
  dbQueryHistoryMessages: 'db:query-history-messages',
  dbDeleteHistoryMessage: 'db:delete-history-message',
  dbClearHistoryMessages: 'db:clear-history-messages',
  dbQueryHistoryLogs: 'db:query-history-logs',
  dbDeleteHistoryLog: 'db:delete-history-log',
  dbClearHistoryLogs: 'db:clear-history-logs',
  dbGetPublishHistory: 'db:get-publish-history',
  dbSavePublish: 'db:save-publish',
  dbGetAllSettings: 'db:get-all-settings',
  dbSaveSetting: 'db:save-setting',
  dbGetStorageStats: 'db:get-storage-stats',
  dbClearHistoryStorage: 'db:clear-history-storage',
  mqttConnect: 'mqtt:connect',
  mqttDisconnect: 'mqtt:disconnect',
  mqttSubscribe: 'mqtt:subscribe',
  mqttUnsubscribe: 'mqtt:unsubscribe',
  mqttPublish: 'mqtt:publish',
  mqttMessages: 'mqtt:messages',
  mqttStatus: 'mqtt:status',
  clipboardReadText: 'clipboard:read-text',
  clipboardWriteText: 'clipboard:write-text',
  windowOpenHistory: 'window:open-history',
  windowOpenExternal: 'window:open-external',
  lifecycleBeforeClose: 'lifecycle:before-close',
  lifecycleBeforeCloseAck: 'lifecycle:before-close-ack',
  updateCheck: 'update:check',
  updateState: 'update:state',
  updateDownload: 'update:download',
  updateCancel: 'update:cancel',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',
});

const DB_HANDLERS = Object.freeze({
  [IPC_CHANNELS.dbGetConnections]: 'getConnections',
  [IPC_CHANNELS.dbSaveConnection]: 'saveConnection',
  [IPC_CHANNELS.dbDeleteConnection]: 'deleteConnection',
  [IPC_CHANNELS.dbGetMessageCounts]: 'getMessageCounts',
  [IPC_CHANNELS.dbGetSubscriptions]: 'getSubscriptions',
  [IPC_CHANNELS.dbAddSubscription]: 'addSubscription',
  [IPC_CHANNELS.dbRemoveSubscription]: 'removeSubscription',
  [IPC_CHANNELS.dbSaveMessages]: 'saveMessages',
  [IPC_CHANNELS.dbSaveLogs]: 'saveLogs',
  [IPC_CHANNELS.dbQueryHistoryMessages]: 'queryHistoryMessages',
  [IPC_CHANNELS.dbDeleteHistoryMessage]: 'deleteHistoryMessage',
  [IPC_CHANNELS.dbClearHistoryMessages]: 'clearHistoryMessages',
  [IPC_CHANNELS.dbQueryHistoryLogs]: 'queryHistoryLogs',
  [IPC_CHANNELS.dbDeleteHistoryLog]: 'deleteHistoryLog',
  [IPC_CHANNELS.dbClearHistoryLogs]: 'clearHistoryLogs',
  [IPC_CHANNELS.dbGetPublishHistory]: 'getPublishHistory',
  [IPC_CHANNELS.dbSavePublish]: 'savePublish',
  [IPC_CHANNELS.dbGetAllSettings]: 'getAllSettings',
  [IPC_CHANNELS.dbSaveSetting]: 'saveSetting',
  [IPC_CHANNELS.dbGetStorageStats]: 'getStorageStats',
  [IPC_CHANNELS.dbClearHistoryStorage]: 'clearHistoryStorage',
});

const INVOKE_CHANNELS = new Set([
  ...Object.keys(DB_HANDLERS),
  IPC_CHANNELS.mqttConnect,
  IPC_CHANNELS.mqttDisconnect,
  IPC_CHANNELS.mqttSubscribe,
  IPC_CHANNELS.mqttUnsubscribe,
  IPC_CHANNELS.mqttPublish,
  IPC_CHANNELS.clipboardReadText,
  IPC_CHANNELS.clipboardWriteText,
  IPC_CHANNELS.windowOpenHistory,
  IPC_CHANNELS.windowOpenExternal,
  IPC_CHANNELS.updateCheck,
  IPC_CHANNELS.updateState,
  IPC_CHANNELS.updateDownload,
  IPC_CHANNELS.updateCancel,
  IPC_CHANNELS.updateInstall,
]);

const HISTORY_CHANNELS = Object.freeze({
  messages: new Set([
    IPC_CHANNELS.clipboardReadText,
    IPC_CHANNELS.clipboardWriteText,
    IPC_CHANNELS.dbGetConnections,
    IPC_CHANNELS.dbGetAllSettings,
    IPC_CHANNELS.dbQueryHistoryMessages,
    IPC_CHANNELS.dbDeleteHistoryMessage,
    IPC_CHANNELS.dbClearHistoryMessages,
  ]),
  logs: new Set([
    IPC_CHANNELS.clipboardReadText,
    IPC_CHANNELS.clipboardWriteText,
    IPC_CHANNELS.dbGetConnections,
    IPC_CHANNELS.dbGetAllSettings,
    IPC_CHANNELS.dbQueryHistoryLogs,
    IPC_CHANNELS.dbDeleteHistoryLog,
    IPC_CHANNELS.dbClearHistoryLogs,
  ]),
});

const BATCH_CHANNELS = new Set([
  IPC_CHANNELS.dbSaveMessages,
  IPC_CHANNELS.dbSaveLogs,
]);

module.exports = {
  IPC_MAX_BATCH_ITEMS,
  IPC_MAX_ITEM_BYTES,
  IPC_MAX_TOTAL_BYTES,
  IPC_CLIPBOARD_MAX_BYTES,
  IPC_CHANNELS,
  DB_HANDLERS,
  INVOKE_CHANNELS,
  HISTORY_CHANNELS,
  BATCH_CHANNELS,
};
