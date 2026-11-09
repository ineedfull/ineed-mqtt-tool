import {
  normalizeScenario,
  prepareScenario,
  SCENARIO_LIMITS,
} from "@ineed-mqtt-tool/domain";
const libraryKey = "mqtt.scenarios.v1";
const reportsKey = "mqtt.scenarioReports.v1";
const serializedBytes = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const serializeLibrary = (scenarios) =>
  JSON.stringify(
    { format: "ineed-mqtt-scenarios", version: 1, scenarios },
    null,
    2,
  );
const libraryBytes = (scenarios) =>
  new TextEncoder().encode(serializeLibrary(scenarios)).byteLength;
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
function validateExecutableScenario(input) {
  const scenario = normalizeScenario(input);
  prepareScenario(scenario, "00000000-0000-4000-8000-000000000000");
  return scenario;
}
function validateLibrarySize(scenarios) {
  if (libraryBytes(scenarios) > SCENARIO_LIMITS.libraryBytes)
    throw new Error("场景库不能超过2MiB，请先导出并删除部分场景");
  if (scenarios.length > SCENARIO_LIMITS.scenarios)
    throw new Error("最多保存100个场景");
}

/** Owns committed library/report snapshots. All storage mutations and loads are serialized. */
export function createScenarioRepository(db) {
  let scenarios = [];
  let reports = [];
  let tail = Promise.resolve();
  // Loads and writes publish snapshots in order; a failed operation does not block the next.
  function enqueue(work) {
    const task = tail.catch(() => {}).then(work);
    tail = task;
    return task;
  }
  async function write(key, value) {
    const result = await db.saveSetting(key, JSON.stringify(value));
    if (result?.ok === false) throw new Error(result.error || "场景保存失败");
  }
  function previewImport(text) {
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).byteLength > SCENARIO_LIMITS.libraryBytes
    )
      throw new Error("导入文件过大或无效");
    const data = JSON.parse(text);
    if (
      data.format !== "ineed-mqtt-scenarios" ||
      data.version !== 1 ||
      !Array.isArray(data.scenarios) ||
      data.scenarios.length > SCENARIO_LIMITS.scenarios
    )
      throw new Error("不支持的场景文件");
    return data.scenarios.map(validateExecutableScenario);
  }
  const api = {
    get scenarios() {
      return cloneJson(scenarios);
    },
    get reports() {
      return cloneJson(reports);
    },
    load() {
      return enqueue(async () => {
        const saved = await db.getAllSettings();
        const next = saved[libraryKey] ? JSON.parse(saved[libraryKey]) : [];
        const nextReports = saved[reportsKey]
          ? JSON.parse(saved[reportsKey])
          : [];
        if (
          !Array.isArray(next) ||
          next.length > SCENARIO_LIMITS.scenarios ||
          !Array.isArray(nextReports) ||
          nextReports.length > SCENARIO_LIMITS.reports
        )
          throw new Error("场景存储无效");
        const nextScenarios = next.map(validateExecutableScenario);
        scenarios = nextScenarios;
        reports = nextReports;
      });
    },
    save(input) {
      return enqueue(async () => {
        const item = validateExecutableScenario(input);
        const next = scenarios.filter((s) => s.id !== item.id).concat(item);
        validateLibrarySize(next);
        await write(libraryKey, next);
        scenarios = next;
        return cloneJson(item);
      });
    },
    remove(id) {
      return enqueue(async () => {
        const next = scenarios.filter((s) => s.id !== id);
        await write(libraryKey, next);
        scenarios = next;
      });
    },
    previewImport,
    importScenarios(items) {
      return enqueue(async () => {
        const imported = items.map((item) =>
          validateExecutableScenario({
            ...item,
            id: globalThis.crypto.randomUUID(),
          }),
        );
        const next = scenarios.concat(imported);
        validateLibrarySize(next);
        await write(libraryKey, next);
        scenarios = next;
      });
    },
    exportScenarios() {
      return serializeLibrary(scenarios);
    },
    saveReport(report) {
      return enqueue(async () => {
        const next = [
          cloneJson(report),
          ...reports.filter((r) => r.runId !== report.runId),
        ].slice(0, SCENARIO_LIMITS.reports);
        while (
          next.length > 1 &&
          serializedBytes(next) > SCENARIO_LIMITS.reportBytes
        )
          next.pop();
        await write(reportsKey, next);
        reports = next;
      });
    },
    flush: () => tail,
  };
  return api;
}
