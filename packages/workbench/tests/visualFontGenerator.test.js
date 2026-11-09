import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as generator from '../e2e/support/generateVisualFontFixture.mjs';
import * as visualSupport from '../e2e/support/captureReference.mjs';

test('font CSS selection accepts a final Fontsource block without trailing newline', () => {
  assert.equal(typeof generator.selectVisualNotoCss, 'function');
  const css = `/* noto-sans-sc-latin-wght-normal */
@font-face {
  font-family: 'Noto Sans SC Variable';
  font-display: swap;
  src: url(./files/noto-sans-sc-latin-wght-normal.woff2) format('woff2-variations');
  unicode-range: U+0000-00FF;
}`;
  const selected = generator.selectVisualNotoCss(css, ['noto-sans-sc-latin-wght-normal.woff2']);
  assert.match(selected, /Visual Noto Sans SC/u);
  assert.match(selected, /font-display: block/u);
  assert.match(selected, /\/__visual_fonts\/noto-sans-sc-latin-wght-normal\.woff2/u);
});

test('committed font fixture retains every selected subset and its unicode ranges', async () => {
  const fontRoot = fileURLToPath(new URL('../e2e/fixtures/fonts/', import.meta.url));
  const verified = await visualSupport.verifyVisualFontFixture({ fontRoot });
  assert.equal(verified.metadata.fonts.ui.files.length, 15);
  assert.match(verified.css, /unicode-range:/u);
  for (const file of verified.metadata.fonts.ui.files) {
    assert.match(verified.css, new RegExp(file.replaceAll('.', '\\.'), 'u'));
  }
  const plugin = visualSupport.createVisualFontPlugin({
    css: verified.css,
    fontRoot,
    metadata: verified.metadata,
  });
  assert.match(plugin.transformIndexHtml('<head></head>'), /unicode-range:/u);
});

test('visual support has no user-specific default and browser styles use only managed families', async () => {
  const support = await readFile(new URL('../e2e/support/captureReference.mjs', import.meta.url), 'utf8');
  const browserFixture = await readFile(new URL('../e2e/fixtures/previewAdapter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(support, /INEED_CURRENT_ELECTRON_REFERENCE|\/Users\//u);
  assert.match(support, /VISUAL_REFERENCE_ROOT/u);
  assert.doesNotMatch(browserFixture, /Arial|Courier New|PingFang|system-ui|-apple-system/u);
  assert.match(browserFixture, /Visual Noto Sans SC/u);
  assert.match(browserFixture, /Visual Roboto Mono/u);
});

test('generated managed reference bundle is excluded from source linting', async () => {
  const eslintConfig = await readFile(new URL('../../../eslint.config.js', import.meta.url), 'utf8');
  assert.match(eslintConfig, /packages\/workbench\/e2e\/fixtures\/reference-renderer/u);
});
