import { matchesTopic } from '@ineed-mqtt-tool/domain/topic-matcher';

const SUBSCRIBE_TIMEOUT_MS = 10000;
const pendingUnsubscriptionPrefix = 'mqtt.pendingUnsubscriptions.';

/**
 * Saved subscription model: id identifies the database row, connId identifies
 * the saved connection (not a socket/session). topic/qos/format/color retain the
 * existing domain model fields; status is pending/active/error/inactive.
 * @typedef {object} Subscription
 * @property {string} id Saved row ID.
 * @property {string} connId Saved connection ID.
 * @property {string} topic MQTT topic filter.
 * @property {number} qos Requested MQTT QoS.
 * @property {string} status Workbench subscription status.
 * @property {string} color Display color.
 * @property {string} format Payload display format.
 */

/**
 * Owns per-connection subscription ordering, durable cleanup and restoration.
 * mqtt/db are the existing runtime facade contracts. Protocol mutations await
 * ACKs; database mutations await their write. Rejections and { ok: false } are
 * handled at each original boundary; partial broker changes may need rollback.
 *
 * workspace reads current models, replaces removed rows and checks availability;
 * it owns the reactive arrays. operations belongs to the Shell: run registers a
 * promise for close drain, isCurrent rejects effects after drain invalidation.
 * This module does not close connections or own the application's drain policy.
 *
 * @param {object} dependencies
 * @param {object} dependencies.mqtt Runtime MQTT facade.
 * @param {object} dependencies.db Runtime database facade.
 * @param {{getConnection: function(string): object|undefined,
 *   getSubscriptions: function(): object[], replaceSubscriptions: function(object[]): void,
 *   hasConnection: function(string): boolean, isClosing: function(): boolean}} dependencies.workspace
 * @param {{run: function(function(number): Promise): Promise,
 *   isCurrent: function(number): boolean}} dependencies.operations
 * @param {function(string, string, string): void} dependencies.addLog Existing UI/persistence logging.
 */
export function createSubscriptionLifecycle({ mqtt: mqttApi, db: dbApi, workspace, operations, addLog }) {
  const { run: runTrackedOperation, isCurrent: isOperationCurrent } = operations;
  const hasActiveConnection = workspace.hasConnection;
  // UI pending deadlines belong to this instance; ACK/removal/disconnect clear
  // individual timers, and Shell disconnectAll clears every timer after drain.
  const subscriptionPendingTimers = new Map();
  const subscriptionConnectionTasks = new Map();
  const reconnectingSubscriptions = new Map();
  let pendingUnsubscriptions = new Map();

  // Saved connection IDs outlive sockets. Manual connect/disconnect/delete each
  // advance requestTokens, invalidating older user requests and restoration.
  const connectionRequestTokens = new Map();
  // Every actual status transition advances statusTokens, including automatic
  // reconnect. A late ACK from the old socket cannot update the new connection.
  const connectionStatusTokens = new Map();

  // Keep deletion, cleanup, and restoration on one connection in their issue order.
  function withSubscriptionConnectionLock(connId, operation) {
    const previous = subscriptionConnectionTasks.get(connId) || Promise.resolve();
    // A failed task must release the queue so cleanup/restoration can retry.
    const task = previous.catch(() => {}).then(operation);
    subscriptionConnectionTasks.set(connId, task);
    // Observe the derived finally promise too: callers handle the task's error.
    void task.finally(() => {
      if (subscriptionConnectionTasks.get(connId) === task) subscriptionConnectionTasks.delete(connId);
    }).catch(() => {});
    return task;
  }

  /** Parse persisted settings without applying them; malformed queues throw. */
  function readPendingUnsubscriptions(saved) {
    const pending = new Map();
    for (const [key, value] of Object.entries(saved || {})) {
      if (!key.startsWith(pendingUnsubscriptionPrefix)) continue;
      const topics = JSON.parse(value);
      if (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string')) {
        throw new Error('待取消订阅记录无效');
      }
      pending.set(key.slice(pendingUnsubscriptionPrefix.length), [...new Set(topics)]);
    }
    return pending;
  }

  async function savePendingUnsubscriptions(connId, topics) {
    requireSuccessfulResult(
      await dbApi.saveSetting(pendingUnsubscriptionPrefix + connId, JSON.stringify(topics)),
      '待取消订阅记录保存失败',
    );
    pendingUnsubscriptions.set(connId, topics);
  }

  async function cleanupPendingUnsubscriptions(connId, isCurrent) {
    const topics = pendingUnsubscriptions.get(connId) || [];
    if (!topics.length) return;
    for (const topic of topics) {
      if (!isCurrent()) return;
      // A saved filter means deletion failed, was interrupted, or the user re-added it.
      if (workspace.getSubscriptions().some(sub => sub.connId === connId && sub.topic === topic)) continue;
      requireSuccessfulResult(await mqttApi.unsubscribe(connId, topic), 'Broker 拒绝清理离线取消订阅');
    }
    if (isCurrent()) await savePendingUnsubscriptions(connId, []);
  }

  function subscriptionPendingKey(sub) {
    return sub.connId + ':' + sub.id;
  }

  function clearSubscriptionPending(sub) {
    const key = subscriptionPendingKey(sub);
    const pending = subscriptionPendingTimers.get(key);
    if (pending) clearTimeout(pending.timer);
    subscriptionPendingTimers.delete(key);
  }

  function markSubscriptionPending(sub) {
    clearSubscriptionPending(sub);
    sub.status = 'pending';
    addLog('info', '正在订阅 ' + sub.topic + ' (QoS' + sub.qos + ')', sub.connId);
    const key = subscriptionPendingKey(sub);
    const timer = setTimeout(() => {
      subscriptionPendingTimers.delete(key);
      if (sub.status !== 'pending') return;
      sub.status = 'error';
      addLog('err', '订阅超时 ' + sub.topic, sub.connId);
    }, SUBSCRIBE_TIMEOUT_MS);
    subscriptionPendingTimers.set(key, { timer, sub });
  }

  function finishSubscriptionPending(sub, ok) {
    clearSubscriptionPending(sub);
    sub.status = ok ? 'active' : 'error';
  }

  function beginConnectionRequest(connId) {
    const requestToken = (connectionRequestTokens.get(connId) || 0) + 1;
    connectionRequestTokens.set(connId, requestToken);
    return requestToken;
  }

  function isConnectionRequestCurrent(connId, requestToken) {
    return connectionRequestTokens.get(connId) === requestToken;
  }

  function updateConnectionStatus(connId, status) {
    const connection = workspace.getConnection(connId);
    if (!connection) return;
    if (connection.status !== status) {
      connectionStatusTokens.set(connId, (connectionStatusTokens.get(connId) || 0) + 1);
    }
    connection.status = status;
    if (status !== 'connected') {
      // Include unsaved drafts waiting for ACK/database completion, so their
      // deadlines cannot report a subscription timeout after a known loss.
      const pending = [...subscriptionPendingTimers.values()].map(item => item.sub);
      for (const sub of new Set([...workspace.getSubscriptions(), ...pending])) {
        if (sub.connId !== connId) continue;
        clearSubscriptionPending(sub);
        sub.status = 'inactive';
      }
    }
  }

  function clearPendingTimers() {
    subscriptionPendingTimers.forEach(({ timer }) => clearTimeout(timer));
    subscriptionPendingTimers.clear();
  }

  function captureSession(connId) {
    const request = connectionRequestTokens.get(connId);
    const status = connectionStatusTokens.get(connId);
    return () => connectionRequestTokens.get(connId) === request
      && connectionStatusTokens.get(connId) === status
      && workspace.getConnection(connId)?.status === 'connected';
  }

  function finishForSession(sub, ok, current) {
    finishSubscriptionPending(sub, ok);
    if (!current()) sub.status = 'inactive';
  }

  async function retainCleanupIntent(connId, topic) {
    await savePendingUnsubscriptions(connId, [...new Set([
      ...(pendingUnsubscriptions.get(connId) || []), topic,
    ])]);
  }

  /**
   * Starts tracked restoration for the captured request/status generations.
   * Same-generation callbacks reuse work; newer generations queue behind it.
   * Returns false on stale results or any failed cleanup/filter, after logging;
   * cleanup failure still permits restoration of all remaining saved filters.
   * @param {string} connId Saved connection ID.
   * @returns {Promise<boolean>}
   */
  async function restoreConnectionSubscriptions(connId) {
    if (workspace.isClosing() || !hasActiveConnection(connId)) return false;
    const connectionToken = connectionRequestTokens.get(connId);
    const statusToken = connectionStatusTokens.get(connId);
    const existing = reconnectingSubscriptions.get(connId);
    // Coalesce repeated callbacks for this connection, but keep a newer connection
    // queued behind a stale ACK so its filters and pending cleanup are not dropped.
    if (existing && existing.connectionToken === connectionToken && existing.statusToken === statusToken) return existing.task;
    const task = runTrackedOperation(operationToken => withSubscriptionConnectionLock(connId, async () => {
      const isCurrent = () => isOperationCurrent(operationToken)
        && connectionRequestTokens.get(connId) === connectionToken
        && connectionStatusTokens.get(connId) === statusToken
        && workspace.getConnection(connId)?.status === 'connected';
      let restored = 0;
      let failed = 0;
      try {
        if (!isCurrent()) return false;
        try {
          await cleanupPendingUnsubscriptions(connId, isCurrent);
        } catch (error) {
          if (!isCurrent()) return false;
          failed += 1;
          addLog('err', '离线取消订阅清理失败，将在下次连接重试: ' + (error?.message || error), connId);
        }
        // Restore every retained filter even when pending cleanup fails. Each filter
        // owns a real broker subscription and its requested QoS, including overlaps.
        for (const sub of workspace.getSubscriptions().filter(item => item.connId === connId)) {
          if (!isCurrent()) return false;
          markSubscriptionPending(sub);
          try {
            const result = await mqttApi.subscribe(connId, sub.topic, sub.qos);
            if (!isCurrent()) return false;
            finishSubscriptionPending(sub, !!result?.ok);
            if (result?.ok) restored += 1;
            else failed += 1;
            addLog(result?.ok ? 'info' : 'err', (result?.ok ? '重连订阅成功 ' : '重连订阅失败 ') + sub.topic, connId);
          } catch (error) {
            if (!isCurrent()) return false;
            finishSubscriptionPending(sub, false);
            failed += 1;
            addLog('err', '重连订阅失败 ' + sub.topic + ': ' + (error?.message || error), connId);
          }
        }
        return failed === 0;
      } finally {
        if (reconnectingSubscriptions.get(connId)?.task === task) reconnectingSubscriptions.delete(connId);
        if (isCurrent()) {
          addLog(failed ? 'warn' : 'info', `订阅恢复完成：成功 ${restored}，失败 ${failed}`, connId);
        }
      }
    }));
    reconnectingSubscriptions.set(connId, { connectionToken, statusToken, task });
    return task;
  }

  // Caller supplies its application generation; all UI wrappers are tracked by
  // Shell so close drains both the broker/database work and UI completion.
  /**
   * @param {Subscription} sub New row prepared by the Shell.
   * @param {number} operationToken Shell application generation.
   * @returns {Promise<boolean>} True after ACK, persistence and local insertion;
   * the retained row is inactive if the connection session changed while saving.
   * False means unavailable/application-stale. Failure attempts compensation
   * only on the captured session, or records cleanup for the next restoration.
   */
  function addSubscription(sub, operationToken) {
    return withSubscriptionConnectionLock(sub.connId, () => subscribeAndPersist(sub, operationToken));
  }

  async function subscribeAndPersist(sub, operationToken) {
    if (!isOperationCurrent(operationToken) || !hasActiveConnection(sub?.connId)) return false;
    const current = captureSession(sub.connId);
    markSubscriptionPending(sub);
    let brokerSubscribed = false;
    try {
      const result = await mqttApi.subscribe(sub.connId, sub.topic, sub.qos);
      if (!isOperationCurrent(operationToken)) return false;
      requireSuccessfulResult(result, 'Broker 拒绝订阅');
      brokerSubscribed = true;
      // Persistence owns the retained filter, not a live-session certificate.
      requireSuccessfulResult(await dbApi.addSubscription({ id: sub.id, connection_id: sub.connId, topic: sub.topic, qos: sub.qos, status: 'inactive', color: sub.color, format: sub.format }), '订阅保存失败');
      if (!isOperationCurrent(operationToken)) return false;
      finishForSession(sub, true, current);
      workspace.getSubscriptions().push({ ...sub });
      addLog('debug', (current() ? '订阅成功 ' : '订阅已保存，等待连接恢复 ') + sub.topic, sub.connId);
      return true;
    } catch (error) {
      let rollbackError = null;
      if (brokerSubscribed && isOperationCurrent(operationToken)) {
        try {
          if (current()) {
            requireSuccessfulResult(await mqttApi.unsubscribe(sub.connId, sub.topic), 'Broker 拒绝回滚订阅');
          } else {
            // The old durable broker session may retain the filter. Let the
            // serialized reconnect cleanup reconcile it; never undo a new socket.
            await retainCleanupIntent(sub.connId, sub.topic);
          }
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
          console.warn('[Vue] subscription rollback failed:', caughtRollbackError?.message || caughtRollbackError);
        }
      }
      if (!isOperationCurrent(operationToken)) return false;
      finishForSession(sub, false, current);
      const primaryMessage = error?.message || String(error);
      const failureMessage = rollbackError
        ? `${primaryMessage}；回滚失败: ${rollbackError?.message || rollbackError}`
        : primaryMessage;
      addLog('err', '订阅失败 ' + sub.topic + ': ' + failureMessage, sub.connId);
      throw new Error(failureMessage, { cause: error });
    } finally {
      clearSubscriptionPending(sub);
    }
  }

  /**
   * Resolves true after broker reconciliation (or durable offline intent), row
   * deletion and local removal; false after generation invalidation. Throws the
   * combined failure after attempting to restore an online filter if needed.
   * @param {Subscription} sub Existing saved row.
   * @param {number} operationToken Shell application generation.
   * @returns {Promise<boolean>}
   */
  async function removeSubscription(sub, operationToken) {
    return withSubscriptionConnectionLock(sub.connId, async () => {
      const current = captureSession(sub.connId);
      let brokerUnsubscribed = false;
      try {
        if (!isOperationCurrent(operationToken)) return false;
        const online = current();
        const retained = workspace.getSubscriptions().filter(item => item.connId === sub.connId && item.id !== sub.id);
        if (online) {
          // Old installations may have saved covered filters without registering them.
          // Establish these paths at their own QoS before removing their broad path.
          for (const remaining of retained.filter(item => matchesTopic(item.topic, sub.topic))) {
            if (!current()) break;
            requireSuccessfulResult(await mqttApi.subscribe(sub.connId, remaining.topic, remaining.qos), 'Broker 拒绝保留订阅');
            if (!isOperationCurrent(operationToken)) return false;
            finishForSession(remaining, true, current);
          }
          if (current() && !retained.some(item => item.topic === sub.topic)) {
            requireSuccessfulResult(await mqttApi.unsubscribe(sub.connId, sub.topic), 'Broker 拒绝取消订阅');
            brokerUnsubscribed = true;
          }
        }
        if (!current()) {
          // Persist intent first so a durable MQTT session can be cleaned after restart.
          const pending = [...new Set([...(pendingUnsubscriptions.get(sub.connId) || []), sub.topic])];
          await savePendingUnsubscriptions(sub.connId, pending);
        }
        if (!isOperationCurrent(operationToken)) return false;
        requireSuccessfulResult(await dbApi.removeSubscription(sub.id), '订阅删除失败');
        if (!isOperationCurrent(operationToken)) return false;
        clearSubscriptionPending(sub);
        workspace.replaceSubscriptions(workspace.getSubscriptions().filter(item => item.id !== sub.id));
        return true;
      } catch (error) {
        let rollbackError = null;
        if (brokerUnsubscribed && isOperationCurrent(operationToken) && current()) {
          try {
            requireSuccessfulResult(await mqttApi.subscribe(sub.connId, sub.topic, sub.qos), 'Broker 拒绝恢复原订阅');
            finishForSession(sub, true, current);
          } catch (caughtRollbackError) {
            rollbackError = caughtRollbackError;
            finishForSession(sub, false, current);
          }
        }
        if (!isOperationCurrent(operationToken)) return false;
        const primaryMessage = error?.message || String(error);
        throw new Error(rollbackError
          ? `${primaryMessage}；恢复原订阅失败: ${rollbackError?.message || rollbackError}`
          : primaryMessage, { cause: error });
      }
    });
  }

  /**
   * Recheck the target session when its queued work starts. An online ACK
   * precedes persistence/local update. A changed session keeps successful saved
   * intent inactive. Failure compensates only the captured session, otherwise
   * retains cleanup intent. Application invalidation resolves false.
   * @param {{source: Subscription, copied: Subscription, existing: Subscription|undefined,
   *   target: object|undefined}} copy
   * @param {number} operationToken Shell application generation.
   * @returns {Promise<boolean>}
   */
  async function copySubscription({ source, copied, existing, target }, operationToken) {
    const targetConnId = copied.connId;
    return withSubscriptionConnectionLock(targetConnId, async () => {
      if (!isOperationCurrent(operationToken) || !hasActiveConnection(targetConnId)) return false;
      const current = captureSession(targetConnId);
      let brokerSubscribed = false;
      try {
        if (current()) {
          requireSuccessfulResult(
            await mqttApi.subscribe(targetConnId, copied.topic, copied.qos),
            'Broker 拒绝订阅',
          );
          if (!isOperationCurrent(operationToken)) return false;
          brokerSubscribed = true;
        }
        requireSuccessfulResult(await dbApi.addSubscription({ id: copied.id, connection_id: copied.connId, topic: copied.topic, qos: copied.qos, status: 'inactive', color: copied.color, format: copied.format }), '订阅保存失败');
        if (!isOperationCurrent(operationToken)) return false;
        finishForSession(copied, true, () => brokerSubscribed && current());
        if (existing) Object.assign(existing, copied);
        else workspace.getSubscriptions().push(copied);
        addLog('info', '已复制订阅 ' + source.topic + ' 到 ' + (target?.name || targetConnId), targetConnId);
        return true;
      } catch (error) {
        let rollbackError = null;
        if (brokerSubscribed && isOperationCurrent(operationToken)) {
          try {
            if (current()) {
              const rollbackResult = existing
                ? await mqttApi.subscribe(targetConnId, existing.topic, existing.qos)
                : await mqttApi.unsubscribe(targetConnId, copied.topic);
              requireSuccessfulResult(rollbackResult, 'Broker 拒绝回滚订阅');
              if (existing) finishForSession(existing, true, current);
            } else {
              await retainCleanupIntent(targetConnId, copied.topic);
            }
          } catch (caughtRollbackError) {
            rollbackError = caughtRollbackError;
            if (existing) finishForSession(existing, false, current);
            console.warn('[Vue] copy subscription rollback failed:', caughtRollbackError?.message || caughtRollbackError);
          }
        }
        if (!isOperationCurrent(operationToken)) return false;
        const primaryMessage = error?.message || String(error);
        throw new Error(rollbackError
          ? `${primaryMessage}；回滚失败: ${rollbackError?.message || rollbackError}`
          : primaryMessage, { cause: error });
      }
    });
  }

  // Own the response filter under the same queue as saved-filter mutations.
  // The durable intent also covers a crash/lost ACK in a persistent session.
  function withResponseSubscription({ connId, topic, isCancelled }, work) {
    const requestToken = connectionRequestTokens.get(connId);
    const statusToken = connectionStatusTokens.get(connId);
    const current = () => connectionRequestTokens.get(connId) === requestToken
      && connectionStatusTokens.get(connId) === statusToken
      && workspace.getConnection(connId)?.status === 'connected';
    return withSubscriptionConnectionLock(connId, async () => {
      if (isCancelled() || !current() || workspace.isClosing()) return;
      const existing = workspace.getSubscriptions().find(sub => sub.connId === connId && sub.topic === topic);
      let attempted = false;
      try {
        if (!existing) await savePendingUnsubscriptions(connId, [...new Set([...(pendingUnsubscriptions.get(connId) || []), topic])]);
        if (isCancelled() || !current()) return;
        attempted = true;
        const result = await mqttApi.subscribe(connId, topic, existing?.qos ?? 1);
        if (result?.ok !== true) throw new Error(result?.error || '响应订阅未确认');
        if (!isCancelled() && current()) await work();
      } finally {
        if (!existing && current()) {
          if (attempted) {
            const result = await mqttApi.unsubscribe(connId, topic);
            requireSuccessfulResult(result?.ok === true ? result : {ok:false,error:result?.error}, '响应订阅清理失败，将在下次连接重试');
          }
          await savePendingUnsubscriptions(connId, (pendingUnsubscriptions.get(connId) || []).filter(item => item !== topic));
        }
      }
    });
  }

  return {
    // Parsing has no state effect: loadData applies the snapshot only if its own
    // application/load generations still match after all workspace reads finish.
    withResponseSubscription,
    readPendingUnsubscriptions,
    applyPendingUnsubscriptions: pending => { pendingUnsubscriptions = pending; },
    addSubscription,
    removeSubscription,
    copySubscription,
    restoreConnectionSubscriptions,
    beginConnectionRequest,
    isConnectionRequestCurrent,
    updateConnectionStatus,
    clearSubscriptionPending,
    clearPendingTimers,
  };
}

function requireSuccessfulResult(result, fallbackMessage) {
  if (result?.ok === false) throw new Error(result.error || fallbackMessage);
  return result;
}
