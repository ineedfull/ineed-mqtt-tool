import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'packages/workbench/src/assets/ineed-mqtt.svg');
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const generated = await mkdtemp(path.join(tmpdir(), 'ineed-mqtt-icons-'));
const tauriIcons = path.join(root, 'apps/tauri/src-tauri/icons');
const electronBuild = path.join(root, 'apps/electron/build');
const electronAssets = path.join(root, 'apps/electron/electron/assets');

try {
  execFileSync(process.execPath, [cli, 'icon', source, '--output', generated], {
    cwd: root,
    stdio: 'pipe',
  });
  for (const directory of [tauriIcons, electronBuild, electronAssets]) {
    await mkdir(directory, { recursive: true });
  }
  for (const name of [
    '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png',
    'icon.png', 'icon.ico', 'icon.icns',
  ]) {
    await copyFile(path.join(generated, name), path.join(tauriIcons, name));
  }
  for (const name of ['icon.ico', 'icon.icns']) {
    await copyFile(path.join(generated, name), path.join(electronBuild, name));
  }
  await copyFile(path.join(generated, 'icon.png'), path.join(electronAssets, 'icon.png'));
  console.log('Updated Electron and Tauri PNG, ICO, and ICNS assets from ineed-mqtt.svg.');
} finally {
  await rm(generated, { recursive: true, force: true });
}
