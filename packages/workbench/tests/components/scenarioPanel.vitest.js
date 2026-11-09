import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi } from "vitest";
import ScenarioPanel from "../../src/components/ScenarioPanel.vue";
import { scenarioExample } from "@ineed-mqtt-tool/domain";
import { createScenarioRepository } from "../../src/workspace/scenarioRepository.js";

describe("shared scenario panel", () => {
  it("keeps a file import preview visible and reports unreadable files", async () => {
    const settings = {};
    const repository = createScenarioRepository({
      getAllSettings: async () => settings,
      saveSetting: async (key, value) => { settings[key] = value; return { ok: true }; },
    });
    await repository.save(scenarioExample("file-example"));
    const w = mount(ScenarioPanel, {
      props: {
        repository,
        runner: { busy: false },
        connection: { id: "c" },
        state: 0,
      },
    });
    await flushPromises();
    const picker = w.get('[aria-label="选择场景文件"]');
    Object.defineProperty(picker.element, "files", {
      configurable: true,
      value: [{ size: 100, text: async () => repository.exportScenarios() }],
    });
    await picker.trigger("change");
    await flushPromises();
    expect(w.text()).toContain("待导入 1 个场景");
    expect(w.get(".scenario-import ul").text()).toContain(
      repository.scenarios[0].name,
    );
    Object.defineProperty(picker.element, "files", {
      configurable: true,
      value: [
        {
          size: 100,
          text: async () => {
            throw Error("file unavailable");
          },
        },
      ],
    });
    await picker.trigger("change");
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain("file unavailable");
    w.unmount();
  });
  it("does not replace edited import text with a late file read", async () => {
    const repository = createScenarioRepository({
      getAllSettings: async () => ({}),
      saveSetting: async () => ({ ok: true }),
    });
    const w = mount(ScenarioPanel, {
      props: {
        repository,
        runner: { busy: false },
        connection: { id: "c" },
        state: 0,
      },
    });
    await flushPromises();
    let finishRead;
    const picker = w.get('[aria-label="选择场景文件"]');
    Object.defineProperty(picker.element, "files", {
      value: [
        {
          size: 100,
          text: () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
        },
      ],
    });
    await picker.trigger("change");
    await w.get('[aria-label="导入场景 JSON"]').setValue("new draft text");
    finishRead(repository.exportScenarios());
    await flushPromises();
    expect(w.get('[aria-label="导入场景 JSON"]').element.value).toBe(
      "new draft text",
    );
    expect(w.find('[data-action="confirm-import"]').exists()).toBe(false);
    w.unmount();
  });
  it("edits/persists, previews import before confirmation, and binds run to current connection", async () => {
    const settings = {};
    const repository = createScenarioRepository({
      getAllSettings: async () => settings,
      saveSetting: async (k, v) => {
        settings[k] = v;
        return { ok: true };
      },
    });
    const runner = {
      start: vi.fn(async () => ({ status: "pass" })),
      stop: vi.fn(),
      busy: false,
    };
    const connection = { id: "lab", name: "Local", status: "connected" };
    const w = mount(ScenarioPanel, {
      props: {
        repository,
        runner,
        connection,
        state: 0,
        latestReport: null,
        closing: false,
      },
    });
    await flushPromises();
    await w.get('[aria-label="场景名称"]').setValue("Read device");
    await w
      .get('[aria-label="场景变量"]')
      .setValue(JSON.stringify({ device: "changed-device" }));
    await w.get('[data-action="save-scenario"]').trigger("click");
    await flushPromises();
    expect(repository.scenarios[0].name).toBe("Read device");
    expect(repository.scenarios[0].variables).toEqual({
      device: "changed-device",
    });
    await w
      .get('[aria-label="导入场景 JSON"]')
      .setValue(repository.exportScenarios());
    await w.get('[data-action="preview-import"]').trigger("click");
    expect(repository.scenarios).toHaveLength(1);
    expect(w.text()).toContain("待导入 1 个场景");
    await w.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();
    expect(repository.scenarios).toHaveLength(2);
    await w.get('[data-action="run-scenario"]').trigger("click");
    await flushPromises();
    expect(runner.start).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Read device",
        variables: { device: "changed-device" },
      }),
      connection,
    );
    w.unmount();
  });
  it("keeps draft and shows failed persistence, disables disconnected execution", async () => {
    const repository = createScenarioRepository({
      getAllSettings: async () => ({}),
      saveSetting: async () => ({ ok: false, error: "disk full" }),
    });
    const w = mount(ScenarioPanel, {
      props: {
        repository,
        runner: { busy: false, start: vi.fn(), stop: vi.fn() },
        connection: { status: "disconnected" },
        state: 0,
        closing: false,
      },
    });
    await flushPromises();
    await w.get('[aria-label="场景名称"]').setValue("draft");
    await w.get('[data-action="save-scenario"]').trigger("click");
    await flushPromises();
    expect(w.text()).toContain("disk full");
    expect(w.get('[aria-label="场景名称"]').element.value).toBe("draft");
    expect(
      w.get('[data-action="run-scenario"]').attributes("disabled"),
    ).toBeDefined();
    w.unmount();
  });
});

describe("assertion editing validation", () => {
  it("does not execute the previous expectation after invalid JSON is typed", async () => {
    const repository = createScenarioRepository({
      getAllSettings: async () => ({}),
      saveSetting: async () => ({ ok: true }),
    });
    const runner = { busy: false, start: vi.fn(), stop: vi.fn() };
    const w = mount(ScenarioPanel, {
      props: {
        repository,
        runner,
        connection: { id: "c", status: "connected" },
        state: 0,
        closing: false,
      },
    });
    await flushPromises();
    await w.get('[aria-label="断言 1 期望"]').setValue("broken JSON");
    await w.get('[data-action="run-scenario"]').trigger("click");
    await flushPromises();
    expect(runner.start).not.toHaveBeenCalled();
    expect(w.text()).toContain("JSON");
    w.unmount();
  });
});
describe("native JSON export", () => {
  it("exposes inspectable JSON and uses existing native clipboard without relying on Tauri webview downloads", async () => {
    const repository = createScenarioRepository({
      getAllSettings: async () => ({}),
      saveSetting: async () => ({ ok: true }),
    });
    const clipboard = { writeText: vi.fn(async () => {}) };
    const w = mount(ScenarioPanel, {
      props: {
        repository,
        runner: { busy: false },
        connection: { id: "c" },
        state: 0,
        closing: false,
        clipboard,
        runtimeName: "tauri",
      },
    });
    await flushPromises();
    await w.get('[data-action="save-scenario"]').trigger("click");
    await flushPromises();
    await w.get('button[data-action="export-scenarios"]').trigger("click");
    expect(
      JSON.parse(w.get('[aria-label="导出 JSON 内容"]').element.value).format,
    ).toBe("ineed-mqtt-scenarios");
    await w.get('[data-action="copy-export"]').trigger("click");
    await flushPromises();
    expect(clipboard.writeText).toHaveBeenCalledWith(
      repository.exportScenarios(),
    );
    expect(
      repository.previewImport(clipboard.writeText.mock.calls[0][0]),
    ).toHaveLength(1);
    expect(w.text()).toContain("JSON 已复制");
    expect(w.find('[data-action="download-export"]').exists()).toBe(false);
    w.unmount();
  });
});
