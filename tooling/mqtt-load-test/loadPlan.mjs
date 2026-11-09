const MIB = 1_024 * 1_024;

export const LOAD_PROTOCOL_LIMITS = Object.freeze({
  payloadHardMaxBytes: 4 * 1_024,
  rustStdinBytes: MIB,
  rustStdoutBytes: 12 * MIB,
  commandEnvelopeBytes: 256,
  persistenceRowOverheadBytes: 1_200,
  nativeEventOverheadBytes: 2_048,
});

export const DEFAULT_LOAD_PLAN = Object.freeze({
  connections: 2,
  topicsPerConnection: 10,
  payloadBytes: 1_024,
  totalMessages: 10_000,
  nativeEventBatch: 200,
  persistenceBatch: 200,
  queueMax: 2_000,
  realtimeMaxPerConnection: 300,
  retryCount: 3,
  publishConcurrency: 16,
  publishRatePerSecond: 4_000,
  timeoutMs: 120_000,
  rssGrowthLimitBytes: 256 * MIB,
});

const OPTION_SPECS = Object.freeze({
  connections: { property: 'connections', minimum: 1, maximum: 16 },
  'topics-per-connection': { property: 'topicsPerConnection', minimum: 1, maximum: 1_000 },
  'payload-bytes': { property: 'payloadBytes', minimum: 1, maximum: MIB },
  'total-messages': { property: 'totalMessages', minimum: 1, maximum: 1_000_000 },
  'native-event-batch': { property: 'nativeEventBatch', minimum: 1, maximum: 200 },
  'persistence-batch': { property: 'persistenceBatch', minimum: 1, maximum: 200 },
  'queue-max': { property: 'queueMax', minimum: 1, maximum: 100_000 },
  'realtime-max-per-connection': { property: 'realtimeMaxPerConnection', minimum: 1, maximum: 10_000 },
  'retry-count': { property: 'retryCount', minimum: 1, maximum: 10 },
  'publish-concurrency': { property: 'publishConcurrency', minimum: 1, maximum: 256 },
  'publish-rate-per-second': { property: 'publishRatePerSecond', minimum: 1, maximum: 100_000 },
  'timeout-ms': { property: 'timeoutMs', minimum: 1, maximum: 600_000 },
  'rss-growth-limit-bytes': { property: 'rssGrowthLimitBytes', minimum: 1, maximum: 2_147_483_648 },
});

function strictInteger(value, label, { minimum, maximum }) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`${label} must be a base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function worstCaseMetadataBytes(plan) {
  const runtime = 'electron';
  const runId = '00000000-0000-0000-0000-000000000000';
  const connection = plan.connections - 1;
  const topic = plan.topicsPerConnection - 1;
  const sequence = (plan.totalMessages / (plan.connections * plan.topicsPerConnection)) - 1;
  const id = `${runtime}/${runId}/c${connection}/t${topic}/s${sequence}`;
  return Buffer.byteLength(`${JSON.stringify({
    id, runtime, runId, connection, topic, sequence,
  })}\n`, 'ascii');
}

export function loadProtocolBounds(plan) {
  return Object.freeze({
    metadataBytes: worstCaseMetadataBytes(plan),
    rustStdinBytes: LOAD_PROTOCOL_LIMITS.commandEnvelopeBytes
      + plan.persistenceBatch
        * (plan.payloadBytes + LOAD_PROTOCOL_LIMITS.persistenceRowOverheadBytes),
    rustStdoutBytes: LOAD_PROTOCOL_LIMITS.commandEnvelopeBytes
      + plan.nativeEventBatch
        * ((plan.payloadBytes * 3) + LOAD_PROTOCOL_LIMITS.nativeEventOverheadBytes),
  });
}

export function validateLoadPlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('load plan must be an object');
  }
  const streams = plan.connections * plan.topicsPerConnection;
  if (plan.totalMessages % streams !== 0) {
    throw new RangeError(
      `totalMessages must be divisible by connections * topicsPerConnection (${streams})`,
    );
  }
  if (plan.persistenceBatch > plan.queueMax) {
    throw new RangeError('persistenceBatch must not exceed queueMax');
  }
  if (plan.publishConcurrency > plan.totalMessages) {
    throw new RangeError('publishConcurrency must not exceed totalMessages');
  }
  const bounds = loadProtocolBounds(plan);
  if (plan.payloadBytes < bounds.metadataBytes) {
    throw new RangeError(
      `payloadBytes ${plan.payloadBytes} cannot contain worst-case metadata (${bounds.metadataBytes} bytes)`,
    );
  }
  if (plan.payloadBytes > LOAD_PROTOCOL_LIMITS.payloadHardMaxBytes) {
    throw new RangeError(
      `payloadBytes must not exceed hard maximum ${LOAD_PROTOCOL_LIMITS.payloadHardMaxBytes}`,
    );
  }
  if (bounds.rustStdinBytes > LOAD_PROTOCOL_LIMITS.rustStdinBytes) {
    throw new RangeError(
      `persistence batch exceeds Rust stdin ${LOAD_PROTOCOL_LIMITS.rustStdinBytes}-byte cap `
      + `(conservative bound ${bounds.rustStdinBytes})`,
    );
  }
  if (bounds.rustStdoutBytes > LOAD_PROTOCOL_LIMITS.rustStdoutBytes) {
    throw new RangeError(
      `native event batch exceeds Rust stdout ${LOAD_PROTOCOL_LIMITS.rustStdoutBytes}-byte cap `
      + `(conservative bound ${bounds.rustStdoutBytes})`,
    );
  }
  return bounds;
}

export function parseLoadArgs(argv = [], env = process.env) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.length === 1 && argv[0] === '--help') {
    return { help: true, record: false, plan: DEFAULT_LOAD_PLAN };
  }
  const values = { ...DEFAULT_LOAD_PLAN };
  const seen = new Set();
  let record = false;
  const envTotal = env?.LOAD_TOTAL_MESSAGES;
  if (envTotal !== undefined && envTotal !== '') {
    values.totalMessages = strictInteger(envTotal, 'LOAD_TOTAL_MESSAGES', OPTION_SPECS['total-messages']);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--record') {
      if (record) throw new Error('duplicate option: --record');
      record = true;
      continue;
    }
    if (argument === '--help') throw new Error('--help cannot be combined with load options');
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${String(argument)}`);
    }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    const spec = OPTION_SPECS[name];
    if (!spec) throw new Error(`unknown option: --${name}`);
    if (seen.has(name)) throw new Error(`duplicate option: --${name}`);
    seen.add(name);
    let rawValue;
    if (equals === -1) {
      rawValue = argv[index + 1];
      if (rawValue === undefined || String(rawValue).startsWith('--')) {
        throw new Error(`missing value for --${name}`);
      }
      index += 1;
    } else {
      rawValue = argument.slice(equals + 1);
    }
    values[spec.property] = strictInteger(rawValue, `--${name}`, spec);
  }

  validateLoadPlan(values);
  return { help: false, record, plan: Object.freeze(values) };
}

export function formatLoadHelp() {
  return `Usage: npm run test:load -- [options]\n\n`
    + `Runs the Electron and Tauri production MQTT persistence harnesses independently.\n`
    + `Every numeric option is a strict positive base-10 integer. total-messages must be\n`
    + `divisible by connections * topics-per-connection.\n\n`
    + `${Object.keys(OPTION_SPECS).map(name => `  --${name}=N`).join('\n')}\n`
    + `  --record   write docs/verification/mqtt-load-test.md\n`
    + `  --help     print help without starting a broker or runtime\n`;
}
