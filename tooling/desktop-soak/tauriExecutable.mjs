import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// A bare Mach-O executable exposes its filename in the macOS Dock. Wrap the
// isolated test host with the product branding without creating a release app.
export async function prepareTauriSoakExecutable(root, outputDirectory) {
  const binary = join(root, 'apps/tauri/src-tauri/target/debug/desktop_soak_harness');
  if (process.platform !== 'darwin') return binary;

  const config = JSON.parse(await readFile(join(root, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8'));
  const name = config.app.windows.find(window => window.label === 'main').title;
  const bundle = join(outputDirectory, 'tauri-host', `${name}.app`);
  const contents = join(bundle, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'), { recursive: true });
  const executable = join(contents, 'MacOS/desktop_soak_harness');
  await copyFile(binary, executable);
  await copyFile(join(root, 'apps/tauri/src-tauri/icons/icon.icns'), join(contents, 'Resources/icon.icns'));
  const entries = {
    CFBundleExecutable: 'desktop_soak_harness',
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleIdentifier: 'com.ineedfull.mqtt-desktop-soak',
    CFBundlePackageType: 'APPL',
    CFBundleVersion: config.version,
    CFBundleShortVersionString: config.version,
    CFBundleIconFile: 'icon.icns',
    NSHighResolutionCapable: true,
  };
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const values = Object.entries(entries).map(([key, value]) => `<key>${key}</key>${typeof value === 'boolean' ? '<true/>' : `<string>${xml(value)}</string>`}`).join('\n');
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${values}</dict></plist>\n`);
  // This signature is for the local test host, not Developer ID distribution.
  execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
  return executable;
}
