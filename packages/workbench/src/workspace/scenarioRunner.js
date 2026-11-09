import {
  normalizeScenario,
  prepareScenario,
  evaluateAssertions,
  readField,
  SCENARIO_LIMITS,
} from "@ineed-mqtt-tool/domain";
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
function decodeMessageEvidence(message) {
  const bytes =
    message.payload instanceof Uint8Array
      ? message.payload
      : Array.isArray(message.payload)
        ? Uint8Array.from(message.payload)
        : new TextEncoder().encode(
            String(message.payloadText ?? message.payload ?? ""),
          );
  const limited = bytes.subarray(0, SCENARIO_LIMITS.payload);
  let raw;
  let invalidUtf8 = false;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(limited);
  } catch {
    raw = new TextDecoder().decode(limited);
    invalidUtf8 = true;
  }
  return {
    raw,
    rawHex: Array.from(limited, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    truncated: bytes.byteLength > limited.byteLength,
    invalidUtf8,
  };
}

/** One runner owns one run until its subscription cleanup settles. Native ACKs
 * cannot be cancelled, so stop freezes business results immediately and late
 * ACKs only release the lease. Connection status invalidates a run permanently. */
export function createScenarioRunner({
  mqtt,
  withResponseSubscription,
  onReport = () => {},
  onState = () => {},
  trackCleanup = () => {},
}) {
  // Active ownership lasts through cleanup, even after the business verdict resolves.
  let active = null;
  let cleanup = Promise.resolve();
  function publishReportSnapshot(run) {
    try {
      onReport(cloneJson(run.report));
    } catch {
      /* reporting cannot revive a run */
    }
  }
  function finishRun(run, status, reason) {
    if (active !== run || run.terminal) return;
    run.terminal = true;
    clearTimeout(run.timer);
    run.report.status = status;
    run.report.reason = reason;
    run.report.finishedAt = Date.now();
    run.resolve(cloneJson(run.report));
    publishReportSnapshot(run);
    onState();
  }
  function hasRunExpired(run) {
    if (!run.terminal && performance.now() >= run.deadline)
      finishRun(run, "timeout", "执行超时（含订阅、发布与等待响应）");
    return run.terminal;
  }
  function recordEvidence(run, message, reason) {
    const raw = decodeMessageEvidence(message);
    const size = raw.rawHex.length / 2;
    if (
      run.report.evidence.length >= SCENARIO_LIMITS.evidence ||
      run.evidenceBytes + size > SCENARIO_LIMITS.evidenceBytes
    ) {
      run.report.droppedEvidence += 1;
      return;
    }
    run.evidenceBytes += size;
    run.report.evidence.push({
      topic: message.topic,
      ...raw,
      receivedAt: Date.now(),
      timestamp: message.timestamp ?? null,
      retained: !!message.retained,
      qos: message.qos ?? 0,
      reason,
    });
  }
  function acceptMessages(batch) {
    const run = active;
    if (!run || hasRunExpired(run)) return;
    for (const message of Array.isArray(batch) ? batch : [batch]) {
      if (hasRunExpired(run)) break;
      if (
        message.connId !== run.report.connection.id ||
        message.topic !== run.report.request.responseTopic
      )
        continue;
      if (!run.armed) {
        recordEvidence(run, message, "before-publish");
        continue;
      }
      if (message.retained) {
        recordEvidence(run, message, "retained");
        continue;
      }
      if (
        typeof message.timestamp === "number" &&
        message.timestamp < run.report.publishedAt
      ) {
        recordEvidence(run, message, "old-timestamp");
        continue;
      }
      const { raw, truncated, invalidUtf8 } = decodeMessageEvidence(message);
      if (truncated) {
        recordEvidence(run, message, "oversize");
        continue;
      }
      if (invalidUtf8) {
        recordEvidence(run, message, "invalid-utf8");
        continue;
      }
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        recordEvidence(run, message, "invalid-json");
        continue;
      }
      if (
        readField(value, run.report.scenario.correlationPath) !==
        run.report.requestId
      ) {
        recordEvidence(run, message, "request-id-mismatch");
        continue;
      }
      recordEvidence(run, message, "matched");
      run.report.response = {
        topic: message.topic,
        raw,
        receivedAt: Date.now(),
        timestamp: message.timestamp ?? null,
      };
      run.report.assertions = evaluateAssertions(
        value,
        run.report.scenario.assertions,
      );
      finishRun(
        run,
        run.report.assertions.every((rule) => rule.passed) ? "pass" : "fail",
        "关联响应已完成业务断言",
      );
    }
  }
  return {
    get busy() {
      return active !== null;
    },
    get cleanup() {
      return cleanup;
    },
    start(input, connection) {
      if (active) throw new Error("上一次场景仍在执行或清理订阅");
      if (connection?.status !== "connected")
        throw new Error("请先连接 MQTT Broker");
      const scenario = normalizeScenario(input);
      const requestId = globalThis.crypto.randomUUID();
      const request = prepareScenario(scenario, requestId);
      let resolve;
      const done = new Promise((r) => {
        resolve = r;
      });
      const run = {
        resolve,
        terminal: false,
        armed: false,
        evidenceBytes: 0,
        deadline: performance.now() + scenario.timeoutMs,
        report: {
          format: "ineed-mqtt-scenario-report",
          version: 1,
          runId: globalThis.crypto.randomUUID(),
          requestId,
          connection: { id: connection.id, name: connection.name },
          scenario,
          request,
          status: "running",
          startedAt: Date.now(),
          finishedAt: null,
          publishedAt: null,
          evidence: [],
          droppedEvidence: 0,
          assertions: [],
          cleanup: "pending",
        },
      };
      active = run;
      onState();
      run.timer = setTimeout(
        () => finishRun(run, "timeout", "执行超时（含订阅、发布与等待响应）"),
        scenario.timeoutMs,
      );
      cleanup = Promise.resolve()
        .then(() =>
          withResponseSubscription(
            {
              connId: connection.id,
              topic: request.responseTopic,
              isCancelled: () => hasRunExpired(run),
            },
            async () => {
              if (hasRunExpired(run)) return;
              run.armed = true;
              run.report.publishedAt = Date.now();
              // Observe PUBACK separately: a device may respond before PUBACK. A hung
              // publish must not hold the subscription after stop/deadline.
              void Promise.resolve()
                .then(() =>
                  hasRunExpired(run)
                    ? { ok: true }
                    : mqtt.publish(
                        connection.id,
                        request.publishTopic,
                        request.payload,
                        scenario.qos,
                        false,
                      ),
                )
                .then(
                  (result) => {
                    if (result?.ok !== true)
                      finishRun(run, "fail", result?.error || "发布失败");
                  },
                  (error) =>
                    finishRun(run, "fail", error?.message || String(error)),
                );
              await done;
            },
          ),
        )
        .then(
          () => {
            if (!run.terminal)
              finishRun(run, "connection-loss", "连接身份已变化，场景未发布");
            run.report.cleanup = "released-or-deferred";
          },
          (error) => {
            if (!run.terminal)
              finishRun(run, "fail", error?.message || String(error));
            run.report.cleanup = "retry-on-connect";
            run.report.cleanupError = error?.message || String(error);
          },
        )
        .finally(() => {
          publishReportSnapshot(run);
          if (active === run) active = null;
          onState();
        });
      trackCleanup(cleanup);
      return done;
    },
    stop() {
      if (active) finishRun(active, "stopped", "用户停止或应用关闭");
    },
    connectionStatus(id, status) {
      if (active?.report.connection.id === id && status !== "connected")
        finishRun(active, "connection-loss", "连接中断，本轮不在重连后继续");
    },
    acceptMessages,
  };
}
