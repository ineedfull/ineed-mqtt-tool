import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioRepository } from "../src/workspace/scenarioRepository.js";
import { scenarioExample } from "../../domain/src/messageScenario.js";

test("loading and saving share the same queue so an older load cannot erase a saved scenario", async () => {
  let releaseLoad;
  let markLoadStarted;
  const loadStarted = new Promise((resolve) => {
    markLoadStarted = resolve;
  });
  const repo = createScenarioRepository({
    getAllSettings: () => {
      markLoadStarted();
      return new Promise((resolve) => {
        releaseLoad = () => resolve({});
      });
    },
    saveSetting: async () => ({ ok: true }),
  });
  const loading = repo.load();
  await loadStarted;
  const saving = repo.save(scenarioExample());
  await new Promise((resolve) => setImmediate(resolve));
  releaseLoad();
  await Promise.all([loading, saving]);
  assert.equal(repo.scenarios.length, 1);
});

test("scenarios persist/reload/edit/delete and import previews do not mutate storage", async () => {
  const settings = { largeFont: true };
  const db = {
    getAllSettings: async () => settings,
    saveSetting: async (key, value) => {
      settings[key] = value;
      return { ok: true };
    },
  };
  const repo = createScenarioRepository(db);
  await repo.load();
  const item = scenarioExample();
  await repo.save(item);
  const preview = repo.previewImport(repo.exportScenarios());
  assert.equal(preview.length, 1);
  assert.equal(repo.scenarios.length, 1);
  await repo.importScenarios(preview);
  assert.equal(repo.scenarios.length, 2);
  await repo.save({ ...item, name: "Edited", version: 2 });
  const reloaded = createScenarioRepository(db);
  await reloaded.load();
  assert.equal(reloaded.scenarios.find((s) => s.id === item.id).name, "Edited");
  await reloaded.remove(item.id);
  assert.equal(reloaded.scenarios.length, 1);
  assert.equal(settings.largeFont, true);
  assert.throws(() => repo.previewImport('{"format":"other"}'));
});

test("failed writes retain last committed library and malformed stored data is surfaced", async () => {
  const repo = createScenarioRepository({
    getAllSettings: async () => ({}),
    saveSetting: async () => ({ ok: false, error: "disk full" }),
  });
  await repo.load();
  await assert.rejects(repo.save(scenarioExample()), /disk full/);
  assert.equal(repo.scenarios.length, 0);
  const corrupt = createScenarioRepository({
    getAllSettings: async () => ({ "mqtt.scenarios.v1": "{" }),
    saveSetting: async () => {},
  });
  await assert.rejects(corrupt.load());
});
test("library byte cap prevents exporting a file that cannot be imported and reports are bounded", async () => {
  const settings = {};
  const repo = createScenarioRepository({
    getAllSettings: async () => settings,
    saveSetting: async (k, v) => {
      settings[k] = v;
      return { ok: true };
    },
  });
  await repo.load();
  const item = scenarioExample();
  item.payloadTemplate = JSON.stringify({
    requestId: "{{requestId}}",
    padding: "x".repeat(60000),
  });
  for (let i = 0; i < 34; i++) await repo.save({ ...item, id: "item-" + i });
  await assert.rejects(repo.save({ ...item, id: "overflow" }), /2MiB/);
  assert.equal(repo.previewImport(repo.exportScenarios()).length, 34);
  const remaining =
    2097152 - new TextEncoder().encode(repo.exportScenarios()).byteLength;
  await assert.rejects(
    repo.save({
      ...item,
      id: "pretty-overflow",
      payloadTemplate: JSON.stringify({ padding: "x".repeat(remaining) }),
    }),
    /2MiB/,
  );
  for (let i = 0; i < 35; i++)
    await repo.saveReport({ runId: "r" + i, status: "pass" });
  assert.equal(repo.reports.length, 30);
  assert.equal(repo.reports[0].runId, "r34");
  const large = "x".repeat(900000);
  for (let i = 0; i < 21; i++)
    await repo.saveReport({ runId: "large" + i, status: "fail", raw: large });
  assert.ok(
    new TextEncoder().encode(settings["mqtt.scenarioReports.v1"]).byteLength <=
      16777216,
  );
});
test("untrusted import validates executable templates, prototype paths and strips credential objects", async () => {
  const repo = createScenarioRepository({
    getAllSettings: async () => ({}),
    saveSetting: async () => ({ ok: true }),
  });
  await repo.load();
  const envelope = (item) =>
    JSON.stringify({
      format: "ineed-mqtt-scenarios",
      version: 1,
      scenarios: [item],
    });
  const item = scenarioExample();
  assert.throws(() =>
    repo.previewImport(envelope({ ...item, payloadTemplate: "not JSON" })),
  );
  assert.throws(() =>
    repo.previewImport(envelope({ ...item, responseTopic: "devices/+/reply" })),
  );
  assert.throws(() =>
    repo.previewImport(
      envelope({ ...item, correlationPath: "data.__proto__.requestId" }),
    ),
  );
  const malicious = JSON.parse(
    envelope({
      ...item,
      password: "secret",
      connection: { password: "secret" },
    }),
  );
  malicious.scenarios[0].variables = JSON.parse('{"__proto__":"pollute"}');
  assert.throws(() => repo.previewImport(JSON.stringify(malicious)));
  const preview = repo.previewImport(
    envelope({
      ...item,
      password: "secret",
      connection: { password: "secret" },
    }),
  );
  assert.equal(JSON.stringify(preview).includes("secret"), false);
  assert.equal({}.pollute, undefined);
});
