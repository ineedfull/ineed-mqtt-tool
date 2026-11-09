/* global process */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_FILES = [
  'noto-sans-sc-105-wght-normal.woff2',
  'noto-sans-sc-107-wght-normal.woff2',
  'noto-sans-sc-108-wght-normal.woff2',
  'noto-sans-sc-109-wght-normal.woff2',
  'noto-sans-sc-110-wght-normal.woff2',
  'noto-sans-sc-111-wght-normal.woff2',
  'noto-sans-sc-112-wght-normal.woff2',
  'noto-sans-sc-113-wght-normal.woff2',
  'noto-sans-sc-114-wght-normal.woff2',
  'noto-sans-sc-115-wght-normal.woff2',
  'noto-sans-sc-116-wght-normal.woff2',
  'noto-sans-sc-117-wght-normal.woff2',
  'noto-sans-sc-118-wght-normal.woff2',
  'noto-sans-sc-119-wght-normal.woff2',
  'noto-sans-sc-latin-wght-normal.woff2',
];
const MONO_FILE = 'roboto-mono-latin-wght-normal.woff2';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function selectVisualNotoCss(sourceCss, uiFiles = UI_FILES) {
  const blocks = [...sourceCss.matchAll(/\/\* noto-sans-sc-[\s\S]*?\n}(?:\n|$)/g)]
    .map(match => match[0])
    .filter(block => uiFiles.some(file => block.includes(file)))
    .map(block => block
      .replaceAll("'Noto Sans SC Variable'", '"Visual Noto Sans SC"')
      .replaceAll('font-display: swap', 'font-display: block')
      .replaceAll('url(./files/', 'url(/__visual_fonts/'));
  if (blocks.length !== uiFiles.length) {
    throw new Error(`Expected ${uiFiles.length} Noto Sans SC CSS blocks, found ${blocks.length}`);
  }
  return blocks.join('\n');
}

export async function generateVisualFontFixture({ monoPackageRoot, notoPackageRoot, outputRoot }) {
  await mkdir(outputRoot, { recursive: true });
  for (const file of UI_FILES) {
    await copyFile(path.join(notoPackageRoot, 'files', file), path.join(outputRoot, file));
  }
  await copyFile(path.join(monoPackageRoot, 'files', MONO_FILE), path.join(outputRoot, MONO_FILE));
  await copyFile(path.join(notoPackageRoot, 'LICENSE'), path.join(outputRoot, 'LICENSE-NOTO-SANS-SC'));
  await copyFile(path.join(monoPackageRoot, 'LICENSE'), path.join(outputRoot, 'LICENSE-ROBOTO-MONO'));

  const notoCss = selectVisualNotoCss(await readFile(path.join(notoPackageRoot, 'wght.css'), 'utf8'));
  const css = `${notoCss}

@font-face {
  font-family: "Visual Roboto Mono";
  font-style: normal;
  font-display: block;
  font-weight: 100 900;
  src: url(/__visual_fonts/${MONO_FILE}) format("woff2-variations");
}

html, body, button, input, select, textarea {
  font-family: "Visual Noto Sans SC" !important;
}

code, pre, kbd, samp, .cm-editor, .cm-editor * {
  font-family: "Visual Roboto Mono" !important;
}
`;
  await writeFile(path.join(outputRoot, 'font.css'), css);

  const files = [
    ...UI_FILES,
    MONO_FILE,
    'LICENSE-NOTO-SANS-SC',
    'LICENSE-ROBOTO-MONO',
    'font.css',
  ].sort();
  const assets = [];
  for (const file of files) {
    const contents = await readFile(path.join(outputRoot, file));
    assets.push({ file, sha256: sha256(contents), size: contents.length });
  }
  const metadata = {
    version: 1,
    assets,
    fonts: {
      mono: { family: 'Visual Roboto Mono', file: MONO_FILE },
      ui: { family: 'Visual Noto Sans SC', files: UI_FILES },
    },
    license: 'SIL Open Font License 1.1',
    sources: [
      {
        integrity: 'sha512-lNar1dF7Ik/lHNPo/7JWG0TolXY29LtsqYgMvEysooZ5bsO9uH4shJmRrwyJ3PjyTPljhpMJEK0jDuLSU4vJ1w==',
        package: '@fontsource-variable/noto-sans-sc',
        url: 'https://www.npmjs.com/package/@fontsource-variable/noto-sans-sc/v/5.3.0',
        version: '5.3.0',
      },
      {
        integrity: 'sha512-h5r+KY/6qy8JEOj33JgcrFO81YAnvrc1EAwMpl/EPJLb2OIvOy0/jmB5M7qs7x/uXk5JUP5Ux4LrkeOK7faHkQ==',
        package: '@fontsource-variable/roboto-mono',
        url: 'https://www.npmjs.com/package/@fontsource-variable/roboto-mono/v/5.3.0',
        version: '5.3.0',
      },
    ],
  };
  await writeFile(path.join(outputRoot, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [notoPackageRoot, monoPackageRoot, outputRoot] = process.argv.slice(2);
  if (!notoPackageRoot || !monoPackageRoot || !outputRoot) {
    throw new Error('Usage: node generateVisualFontFixture.mjs <noto-package-root> <mono-package-root> <output-root>');
  }
  await generateVisualFontFixture({ monoPackageRoot, notoPackageRoot, outputRoot });
}
