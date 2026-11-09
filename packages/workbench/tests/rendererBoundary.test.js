import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Linter } from 'eslint';

const rendererEntries = [
  '../../../apps/electron/renderer/main.js',
  '../../../apps/tauri/renderer/main.js',
];
const rendererServers = [
  ['../../../apps/electron/vite.config.js', 5173],
  ['../../../apps/tauri/vite.config.js', 5175],
];
const rendererDevScripts = [
  ['electron', 'npm run dev -w @ineed-mqtt-tool/electron'],
  ['tauri', 'npm run dev:renderer -w @ineed-mqtt-tool/tauri'],
];
const invalidRendererSources = [
  [
    'commented imports with inline UI',
    'Import createWorkbench from the workbench package.',
    `
/* import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css'; */
createApp({ template: '<main>Inline UI</main>' }).mount('#app');
`,
  ],
  [
    'createApp mounted instead of the workbench',
    'Renderer shells must not call createApp.',
    `
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
createApp({ template: '<main>Inline UI</main>' }).mount('#app');
`,
  ],
  [
    'workbench created without mounting it',
    "Mount createWorkbench(adapter) on '#app'.",
    `
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
createWorkbench(adapter);
`,
  ],
  [
    'an extra inline UI mount beside the workbench mount',
    'Renderer shells must contain exactly one mount call.',
    `
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
createWorkbench(adapter).mount('#app');
createApp({ template: '<main>Inline UI</main>' }).mount('#other');
`,
  ],
  [
    'a dynamic Vue component import beside the workbench mount',
    'Renderer shells must not import Vue components.',
    `
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
import('./Inline.vue');
createWorkbench(adapter).mount('#app');
`,
  ],
  [
    'a direct Vue runtime import beside the workbench mount',
    'Renderer shells must not import Vue directly.',
    `
import { createApp } from 'vue';
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
createWorkbench(adapter).mount('#app');
`,
  ],
  [
    'a computed workbench mount with a template target',
    "Mount createWorkbench(adapter) on '#app'.",
    `
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
createWorkbench(adapter)['mount'](\`#app\`);
`,
  ],
];
const futureRendererSource = `
import { adapter } from '../runtimeAdapter.js';
import { createWorkbench } from '@ineed-mqtt-tool/workbench';
import '@ineed-mqtt-tool/workbench/base.css';
const app = createWorkbench(adapter);
app.mount('#app');
`;

function staticStringValue(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function memberPropertyName(node) {
  if (node.type !== 'MemberExpression') {
    return null;
  }
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return node.computed ? staticStringValue(node.property) : null;
}

function isCreateAppCall(node) {
  return node.callee.type === 'Identifier'
    ? node.callee.name === 'createApp'
    : memberPropertyName(node.callee) === 'createApp';
}

function isMountCall(node) {
  return memberPropertyName(node.callee) === 'mount';
}

function isWorkbenchMount(node) {
  if (!isMountCall(node) || node.callee.computed) {
    return false;
  }

  const createCall = node.callee.object;
  return createCall.type === 'CallExpression'
    && createCall.callee.type === 'Identifier'
    && createCall.callee.name === 'createWorkbench'
    && createCall.arguments.length === 1
    && createCall.arguments[0].type === 'Identifier'
    && createCall.arguments[0].name === 'adapter'
    && node.arguments.length === 1
    && node.arguments[0].type === 'Literal'
    && node.arguments[0].value === '#app';
}

function isWorkbenchCreation(node) {
  return node?.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && node.callee.name === 'createWorkbench'
    && node.arguments.length === 1
    && node.arguments[0].type === 'Identifier'
    && node.arguments[0].name === 'adapter';
}

const rendererBoundaryRule = {
  meta: {
    schema: [],
    type: 'problem',
  },
  create(context) {
    let importsBaseCss = false;
    let importsCreateWorkbench = false;
    let mountCallCount = 0;
    let workbenchMountCount = 0;
    const workbenchApps = new Set();

    function reportForbiddenImport(node, specifier) {
      if (/\.vue(?:[?#].*)?$/.test(specifier)) {
        context.report({ node, message: 'Renderer shells must not import Vue components.' });
      }
      if (specifier === 'vue' || specifier.startsWith('vue/')) {
        context.report({ node, message: 'Renderer shells must not import Vue directly.' });
      }
    }

    return {
      ImportDeclaration(node) {
        const specifier = node.source.value;

        if (specifier === '@ineed-mqtt-tool/workbench') {
          importsCreateWorkbench = node.specifiers.some(importSpecifier => (
            importSpecifier.type === 'ImportSpecifier'
            && importSpecifier.imported.name === 'createWorkbench'
            && importSpecifier.local.name === 'createWorkbench'
          ));
        }
        if (specifier === '@ineed-mqtt-tool/workbench/base.css') {
          importsBaseCss = node.specifiers.length === 0;
        }
        reportForbiddenImport(node, specifier);
      },
      ImportExpression(node) {
        const specifier = staticStringValue(node.source);

        if (specifier !== null) {
          reportForbiddenImport(node, specifier);
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isWorkbenchCreation(node.init)) {
          workbenchApps.add(node.id.name);
        }
      },
      CallExpression(node) {
        if (isCreateAppCall(node)) {
          context.report({ node, message: 'Renderer shells must not call createApp.' });
        }
        if (isMountCall(node)) {
          mountCallCount += 1;
          const mountsNamedWorkbench = node.callee.object.type === 'Identifier'
            && workbenchApps.has(node.callee.object.name)
            && node.arguments.length === 1
            && staticStringValue(node.arguments[0]) === '#app';
          if (isWorkbenchMount(node) || mountsNamedWorkbench) {
            workbenchMountCount += 1;
          }
        }
      },
      'Program:exit'(node) {
        if (!importsCreateWorkbench) {
          context.report({ node, message: 'Import createWorkbench from the workbench package.' });
        }
        if (!importsBaseCss) {
          context.report({ node, message: 'Import workbench/base.css for side effects.' });
        }
        if (mountCallCount !== 1) {
          context.report({ node, message: 'Renderer shells must contain exactly one mount call.' });
        }
        if (workbenchMountCount !== 1) {
          context.report({ node, message: "Mount createWorkbench(adapter) on '#app'." });
        }
      },
    };
  },
};
const rendererLinter = new Linter();

function analyzeRendererSource(source) {
  return rendererLinter.verify(source, {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      rendererBoundary: {
        rules: {
          shell: rendererBoundaryRule,
        },
      },
    },
    rules: {
      'rendererBoundary/shell': 'error',
    },
  });
}

function assertThinRendererSource(source, label) {
  const nonblankLines = source.split('\n').filter(line => line.trim() !== '');
  const messages = analyzeRendererSource(source);

  assert.deepEqual(messages, [], label);
  assert.ok(nonblankLines.length <= 12, `${label} has ${nonblankLines.length} nonblank lines`);
}

for (const [name, expectedDiagnostic, source] of invalidRendererSources) {
  test(`renderer boundary rejects ${name}`, () => {
    const diagnostics = analyzeRendererSource(source).map(message => message.message);

    assert.equal(
      diagnostics.includes(expectedDiagnostic),
      true,
      `${name}: expected ${expectedDiagnostic}; received ${diagnostics.join(' | ')}`,
    );
  });
}

test('renderer boundary allows a future local runtime adapter import', () => {
  assertThinRendererSource(futureRendererSource, 'future local runtime adapter');
});

for (const [runtime, expectedScript] of rendererDevScripts) {
  test(`root dev:${runtime} script starts its runtime workspace`, async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../../../package.json', import.meta.url),
      'utf8',
    ));

    assert.equal(manifest.scripts[`dev:${runtime}`], expectedScript);
  });
}

test('Electron keeps a renderer-only dev alias and uses kill-on-exit orchestration', async () => {
  const [rootManifest, electronManifest] = await Promise.all([
    readFile(new URL('../../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../../apps/electron/package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);

  assert.equal(
    rootManifest.scripts['dev:electron:renderer'],
    'npm run dev:renderer -w @ineed-mqtt-tool/electron',
  );
  assert.match(electronManifest.scripts.dev, /^concurrently -k /);
});

for (const [configPath, port] of rendererServers) {
  test(`${configPath} binds its renderer server to loopback`, async () => {
    const { default: config } = await import(new URL(configPath, import.meta.url));

    assert.deepEqual(config.server, {
      host: '127.0.0.1',
      port,
      strictPort: true,
    });
  });
}

for (const rendererEntry of rendererEntries) {
  test(`${rendererEntry} stays a thin workbench bootstrap`, async () => {
    const source = await readFile(new URL(rendererEntry, import.meta.url), 'utf8');

    assertThinRendererSource(source, rendererEntry);
  });
}
