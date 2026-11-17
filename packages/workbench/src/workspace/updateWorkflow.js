import { ref, computed } from 'vue';
import { validateHttpsUpdateUrl } from './updateUrl.js';

/** Owns update UI state and single-flight preparation. The shell owns app resources.
 * Late checks use the shell's operation generation; failed preparation unlocks it.
 */
export function createUpdateWorkflow({
  runtimeFacade,
  closing,
  actionError,
  runTrackedOperation,
  isOperationCurrent,
  getTeardown,
  prepareForInstall,
}) {
  const checking = ref(false);
  const updateInfo = ref(null);
  const updateState = ref({ phase: 'idle', supported: false });
  const updateBusy = computed(() =>
    ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(updateState.value.phase),
  );
  let updatePreparing = false;
  let updatePreparation = null;
  function acceptUpdateState(state) {
    updateState.value = state;
    if (state.phase === 'preparing') {
      closing.value = true;
      updatePreparing = true;
    }
    if (['available', 'ready', 'error'].includes(state.phase) && updatePreparing && !getTeardown()) {
      closing.value = false;
      updatePreparing = false;
    }
  }
  async function prepareForUpdate() {
    if (getTeardown()) throw new Error('应用正在关闭');
    if (updatePreparation) return updatePreparation;
    closing.value = true;
    updatePreparing = true;
    updatePreparation = prepareForInstall()
      .catch(error => {
        closing.value = false;
        updatePreparing = false;
        throw error;
      })
      .finally(() => { updatePreparation = null; });
    return updatePreparation;
  }
  async function runUpdateAction(method) {
    try {
      await runtimeFacade.update[method]();
    } catch (error) {
      updateState.value = { ...updateState.value, error: error.message };
      if (method === 'install' && !getTeardown()) {
        closing.value = false;
        updatePreparing = false;
      }
    }
  }
  async function checkUpdate() {
    if (closing.value || checking.value || updateBusy.value) return false;
    checking.value = true;
    updateInfo.value = null;
    return runTrackedOperation(async operationToken => {
      try {
        const data = await runtimeFacade.update.check();
        if (!isOperationCurrent(operationToken)) return false;
        updateInfo.value = data;
        return true;
      } catch (e) {
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

  return {
    checking, updateInfo, updateState, updateBusy,
    acceptUpdateState, prepareForUpdate, runUpdateAction, checkUpdate, openUpdateDownload,
    isPreparing: () => updatePreparing,
  };
}
