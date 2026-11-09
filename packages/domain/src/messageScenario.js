/* global TextEncoder */
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const types = ["string", "number", "boolean", "object", "array", "null"];
export const SCENARIO_LIMITS = Object.freeze({
  scenarios: 100,
  reports: 30,
  evidence: 64,
  evidenceBytes: 262144,
  payload: 65536,
  libraryBytes: 2097152,
  reportBytes: 16777216,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
function string(value, label, max = 1024) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}无效`);
  return value;
}
function pathParts(path) {
  string(path, "JSON 字段路径", 256);
  const parts = path.split(".");
  if (
    parts.length > 16 ||
    parts.some(
      (part) =>
        !/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(part) || forbidden.has(part),
    )
  )
    throw new Error(
      "仅支持安全的点分隔 JSON 路径，如 data.requestId、items.0.value",
    );
  return parts;
}
export function readField(value, path) {
  for (const part of pathParts(path)) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = value[part];
  }
  return value;
}
function assignField(value, path, field) {
  const parts = pathParts(path);
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(value, part)) value[part] = {};
    value = value[part];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("请求关联路径必须指向 JSON 对象字段");
  }
  value[parts.at(-1)] = field;
}
export function normalizeScenario(input) {
  if (!input || typeof input !== "object") throw new Error("场景无效");
  const variables = input.variables ?? {};
  if (
    !variables ||
    typeof variables !== "object" ||
    Array.isArray(variables) ||
    Object.keys(variables).length > 32
  )
    throw new Error("变量必须是 JSON 对象，最多32项");
  for (const [key, value] of Object.entries(variables)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      forbidden.has(key) ||
      key === "requestId" ||
      typeof value !== "string" ||
      value.length > 4096
    )
      throw new Error("变量名无效、使用保留名 requestId 或变量值不是字符串");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new Error("场景版本必须是正整数");
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 50 ||
    input.timeoutMs > 300000
  )
    throw new Error("超时必须为50至300000毫秒");
  if (![0, 1, 2].includes(input.qos)) throw new Error("QoS 无效");
  pathParts(input.correlationPath);
  if (
    !Array.isArray(input.assertions) ||
    !input.assertions.length ||
    input.assertions.length > 32
  )
    throw new Error("需要1至32条断言");
  const assertions = input.assertions.map((rule) => {
    pathParts(rule.path);
    if (rule.operator === "range") {
      if (
        !Number.isFinite(rule.min) ||
        !Number.isFinite(rule.max) ||
        rule.min > rule.max
      )
        throw new Error("数值范围无效");
      return {
        path: rule.path,
        operator: "range",
        min: rule.min,
        max: rule.max,
      };
    }
    if (rule.operator === "type" && types.includes(rule.expected))
      return { path: rule.path, operator: "type", expected: rule.expected };
    const isJsonScalar =
      rule.expected === null ||
      ["string", "number", "boolean"].includes(typeof rule.expected);
    if (
      rule.operator === "equals" &&
      Object.hasOwn(rule, "expected") &&
      isJsonScalar
    ) {
      if (
        JSON.stringify(rule.expected).length > 4096 ||
        (typeof rule.expected === "number" && !Number.isFinite(rule.expected))
      )
        throw new Error("期望值无效");
      return { path: rule.path, operator: "equals", expected: rule.expected };
    }
    throw new Error("断言只支持 equals（JSON标量）、type、range");
  });
  return {
    id: string(input.id, "场景 ID", 128),
    name: string(input.name, "场景名称", 128),
    version: input.version,
    publishTopic: string(input.publishTopic, "发布主题", 4096),
    responseTopic: string(input.responseTopic, "响应主题", 4096),
    payloadTemplate: string(
      input.payloadTemplate,
      "载荷模板",
      SCENARIO_LIMITS.payload,
    ),
    variables: clone(variables),
    correlationPath: input.correlationPath,
    timeoutMs: input.timeoutMs,
    qos: input.qos,
    assertions,
  };
}
function render(template, variables, json = false) {
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(variables, key)) throw new Error(`缺少变量 ${key}`);
    return json ? JSON.stringify(variables[key]).slice(1, -1) : variables[key];
  });
}
function topic(value) {
  if (!value || /[+#]|\p{Cc}/u.test(value) || value.length > 4096)
    throw new Error("场景主题必须是具体主题，不能含通配符或控制字符");
  return value;
}
export function prepareScenario(input, requestId) {
  const scenario = normalizeScenario(input);
  const variables = { ...scenario.variables, requestId };
  const payload = JSON.parse(render(scenario.payloadTemplate, variables, true));
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("请求载荷必须是 JSON 对象");
  assignField(payload, scenario.correlationPath, requestId);
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > SCENARIO_LIMITS.payload)
    throw new Error("请求载荷过大");
  return {
    publishTopic: topic(render(scenario.publishTopic, variables)),
    responseTopic: topic(render(scenario.responseTopic, variables)),
    payload: serialized,
  };
}
function jsonType(value) {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
}
export function evaluateAssertions(value, assertions) {
  return assertions.map((rule) => {
    const actual = readField(value, rule.path);
    let passed;
    if (rule.operator === "equals") passed = actual === rule.expected;
    else if (rule.operator === "type")
      passed = jsonType(actual) === rule.expected;
    else
      passed =
        typeof actual === "number" &&
        Number.isFinite(actual) &&
        actual >= rule.min &&
        actual <= rule.max;
    return {
      ...rule,
      actual: actual === undefined ? null : clone(actual),
      missing: actual === undefined,
      passed,
    };
  });
}
export function scenarioExample(id = "example-scenario") {
  return {
    id,
    name: "设备指令响应",
    version: 1,
    publishTopic: "devices/{{device}}/command",
    responseTopic: "devices/{{device}}/response",
    payloadTemplate: '{"requestId":"{{requestId}}","command":"read"}',
    variables: { device: "unit-1" },
    correlationPath: "requestId",
    timeoutMs: 5000,
    qos: 1,
    assertions: [
      { path: "status", operator: "equals", expected: "ok" },
      { path: "temperature", operator: "type", expected: "number" },
      { path: "temperature", operator: "range", min: 20, max: 30 },
    ],
  };
}
