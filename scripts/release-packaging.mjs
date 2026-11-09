#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveCli } from './desktop-release.mjs';

export const APP_IDENTIFIER = 'com.ineedfull.mqtt-tool';
export const PRODUCT_NAME = 'Ineed MQTT Tool';

const RELEASE_TARGETS = Object.freeze([
  Object.freeze({
    hostPlatform: 'darwin',
    platform: 'macos',
    architecture: 'arm64',
    rustTarget: 'aarch64-apple-darwin',
    electron: Object.freeze({ target: 'dmg', extension: 'dmg' }),
    tauri: Object.freeze({ bundles: 'dmg', extension: 'dmg' }),
  }),
  Object.freeze({
    hostPlatform: 'darwin',
    platform: 'macos',
    architecture: 'x64',
    rustTarget: 'x86_64-apple-darwin',
    electron: Object.freeze({ target: 'dmg', extension: 'dmg' }),
    tauri: Object.freeze({ bundles: 'dmg', extension: 'dmg' }),
  }),
  Object.freeze({
    hostPlatform: 'win32',
    platform: 'windows',
    architecture: 'x64',
    rustTarget: 'x86_64-pc-windows-msvc',
    electron: Object.freeze({ target: 'nsis', extension: 'exe' }),
    tauri: Object.freeze({ bundles: 'nsis', extension: 'exe' }),
  }),
  Object.freeze({
    hostPlatform: 'win32',
    platform: 'windows',
    architecture: 'ia32',
    rustTarget: 'i686-pc-windows-msvc',
    electron: Object.freeze({ target: 'nsis', extension: 'exe' }),
    tauri: Object.freeze({ bundles: 'nsis', extension: 'exe' }),
  }),
  Object.freeze({
    hostPlatform: 'linux',
    platform: 'linux',
    architecture: 'x64',
    rustTarget: 'x86_64-unknown-linux-gnu',
    electron: Object.freeze({ target: 'AppImage', extension: 'AppImage' }),
    tauri: Object.freeze({ bundles: 'appimage', extension: 'AppImage' }),
  }),
]);

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..');
const BUILD_TIME_PATTERN = /^\d{8}T\d{6}Z$/u;

function pad(value) {
  return String(value).padStart(2, '0');
}

function cloneReleaseTarget(target) {
  return {
    platform: target.platform,
    architecture: target.architecture,
    rustTarget: target.rustTarget,
    electron: { ...target.electron },
    tauri: { ...target.tauri },
  };
}

export function formatBuildTime(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new TypeError('Release build time must be a valid Date');
  }
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function hostReleaseTarget({ platform = process.platform, arch = process.arch } = {}) {
  const target = RELEASE_TARGETS.find(
    (candidate) => candidate.hostPlatform === platform && candidate.architecture === arch,
  );
  if (!target) throw new Error(`Unsupported release host: ${platform}-${arch}`);
  return cloneReleaseTarget(target);
}

export function releaseTargetsForPlatform(platform = process.platform) {
  const targets = RELEASE_TARGETS
    .filter((target) => target.hostPlatform === platform)
    .map(cloneReleaseTarget);
  if (targets.length === 0) throw new Error(`Unsupported release platform: ${platform}`);
  return targets;
}

function requireReleaseToken(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid release ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function releaseArtifactName({ runtime, version, buildTime, target }) {
  requireReleaseToken(runtime, 'runtime', /^(?:electron|tauri)$/u);
  requireReleaseToken(version, 'version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
  requireReleaseToken(buildTime, 'build time', BUILD_TIME_PATTERN);
  const extension = target?.[runtime]?.extension;
  requireReleaseToken(target?.platform, 'platform', /^(?:macos|windows|linux)$/u);
  requireReleaseToken(target?.architecture, 'architecture', /^(?:arm64|x64|ia32)$/u);
  requireReleaseToken(extension, 'extension', /^(?:dmg|exe|AppImage)$/u);
  return `Ineed-MQTT-Tool-${version}-${runtime}-${target.platform}-${target.architecture}-${buildTime}.${extension}`;
}

export function releaseManifestName(target) {
  requireReleaseToken(target?.platform, 'platform', /^(?:macos|windows|linux)$/u);
  requireReleaseToken(target?.architecture, 'architecture', /^(?:arm64|x64|ia32)$/u);
  return `release-manifest-${target.platform}-${target.architecture}.json`;
}

function isContained(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const EXCLUDED_ELECTRON_WORKSPACE_PACKAGES = [
  // mqtt-contract/endpoint is also required by the native connection boundary.
  'node_modules/@ineed-mqtt-tool/runtime-contract',
  'node_modules/@ineed-mqtt-tool/workbench',
];

export function isForbiddenPackagePath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/');
  const basename = segments.at(-1)?.toLowerCase() ?? '';
  return EXCLUDED_ELECTRON_WORKSPACE_PACKAGES.some(
    (packagePath) => normalized === packagePath || normalized.startsWith(`${packagePath}/`),
  ) || /\.db(?:-(?:journal|wal|shm))?$/iu.test(basename)
    || /^\.env(?:\..+)?$/u.test(basename)
    || /\.log$/iu.test(basename)
    || /\.map$/iu.test(basename)
    || segments.some((segment) => /^(?:test|tests|fixtures|logs)$/iu.test(segment));
}

export async function pruneElectronPackage(appRoot) {
  const rootMetadata = await lstat(appRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Electron package root must be a real directory: ${appRoot}`);
  }
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(appRoot, entryPath);
      if (isForbiddenPackagePath(relativePath)) {
        await rm(entryPath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(appRoot);
}

async function electronAppRoot(appOutDir) {
  if (process.platform === 'darwin') {
    const apps = (await readdir(appOutDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (apps.length !== 1) {
      throw new Error(`Expected exactly one Electron app bundle in ${appOutDir}, found ${apps.length}`);
    }
    return path.join(appOutDir, apps[0].name, 'Contents', 'Resources', 'app');
  }
  return path.join(appOutDir, 'resources', 'app');
}

export default async function electronAfterPack(context) {
  const appOutDir = path.resolve(context?.appOutDir ?? '');
  if (!path.isAbsolute(appOutDir) || appOutDir === path.parse(appOutDir).root) {
    throw new Error(`Electron afterPack received an unsafe output directory: ${appOutDir}`);
  }
  const appRoot = await electronAppRoot(appOutDir);
  const canonicalOutput = await realpath(appOutDir);
  const canonicalAppRoot = await realpath(appRoot);
  if (!isContained(canonicalAppRoot, canonicalOutput)) {
    throw new Error(`Electron package root escapes its output directory: ${canonicalAppRoot}`);
  }
  await pruneElectronPackage(canonicalAppRoot);
}

export async function cleanArtifactDirectories({
  projectRoot = defaultProjectRoot,
  artifactRoot = path.join(projectRoot, 'artifacts'),
} = {}) {
  const canonicalProject = await realpath(projectRoot);
  const expectedInputRoot = path.resolve(projectRoot, 'artifacts');
  if (path.resolve(artifactRoot) !== expectedInputRoot) {
    throw new Error(`Artifact root must be the project artifacts directory: ${expectedInputRoot}`);
  }

  await mkdir(expectedInputRoot, { recursive: true });
  const artifactMetadata = await lstat(expectedInputRoot);
  if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isDirectory()) {
    throw new Error(`Artifact root must be a real directory: ${expectedInputRoot}`);
  }
  const expectedArtifactRoot = await realpath(expectedInputRoot);
  if (!isContained(expectedArtifactRoot, canonicalProject)) {
    throw new Error(`Artifact root must remain within the project: ${expectedArtifactRoot}`);
  }

  const directories = {
    electron: path.join(expectedInputRoot, 'electron'),
    tauri: path.join(expectedInputRoot, 'tauri'),
  };
  for (const directory of Object.values(directories)) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
  }
  return directories;
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const details = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `Release command failed: ${command} ${args.join(' ')}${details ? `\n${details}` : ''}`,
      { cause: error },
    );
  }
}

async function findOnlyFile(root, extension) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(`.${extension}`)) matches.push(entryPath);
    }
  }
  await visit(root);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one .${extension} package under ${root}, found ${matches.length}`);
  }
  const metadata = await stat(matches[0]);
  if (metadata.size === 0) throw new Error(`Release artifact is empty: ${matches[0]}`);
  return matches[0];
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function readReleaseConfiguration(projectRoot) {
  const [rootManifest, electronManifest, tauriConfig, cargoManifest] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'apps/electron/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'apps/tauri/src-tauri/Cargo.toml'), 'utf8'),
  ]);
  const version = requireReleaseToken(rootManifest.version, 'version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
  const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoManifest)?.[1];
  if (electronManifest.version !== version || tauriConfig.version !== version || cargoVersion !== version) {
    throw new Error('Root, Electron, Tauri config, and Cargo versions must match');
  }
  if (electronManifest.build?.appId !== APP_IDENTIFIER || tauriConfig.identifier !== APP_IDENTIFIER) {
    throw new Error(`Both runtime identifiers must equal ${APP_IDENTIFIER}`);
  }
  return { version };
}

async function writeRuntimeManifest({ directory, runtime, artifactPath, version, buildTime, target }) {
  const artifactMetadata = await stat(artifactPath);
  const manifest = {
    schemaVersion: 1,
    runtime,
    product: PRODUCT_NAME,
    identifier: APP_IDENTIFIER,
    version,
    buildTime,
    platform: target.platform,
    architecture: target.architecture,
    artifact: {
      name: path.basename(artifactPath),
      size: artifactMetadata.size,
      sha256: await sha256(artifactPath),
    },
  };
  await writeFile(path.join(directory, releaseManifestName(target)), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}

function platformBuilderArgs(target, outputDirectory) {
  const architectureFlag = `--${target.architecture}`;
  const platformFlag = target.platform === 'macos' ? '--mac' : target.platform === 'windows' ? '--win' : '--linux';
  return [
    platformFlag,
    target.electron.target,
    architectureFlag,
    `--config.directories.output=${outputDirectory}`,
  ];
}

async function buildElectron({ projectRoot, nativeRoot, environment, target }) {
  const cwd = path.join(projectRoot, 'apps/electron');
  await run(process.execPath, [resolveCli(projectRoot, 'electron', 'vite', 'vite'), 'build'], { cwd, env: environment });
  await run(process.execPath, [resolveCli(projectRoot, 'electron', 'electron-builder', 'electron-builder'), ...platformBuilderArgs(target, nativeRoot)], {
    cwd: path.join(projectRoot, 'apps/electron'),
    env: {
      ...environment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ELECTRON_BUILDER_BINARIES_MIRROR: environment.ELECTRON_BUILDER_BINARIES_MIRROR
        ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  });
  return findOnlyFile(nativeRoot, target.electron.extension);
}

async function buildTauri({ projectRoot, nativeRoot, environment, target }) {
  const args = [
    'build',
    '--target',
    target.rustTarget,
    '--bundles',
    target.tauri.bundles,
    '--no-sign',
    '--ci',
  ];
  await run(process.execPath, [resolveCli(projectRoot, 'tauri', '@tauri-apps/cli', 'tauri'), ...args], {
    cwd: path.join(projectRoot, 'apps/tauri'),
    env: { ...environment, CARGO_TARGET_DIR: nativeRoot },
  });
  return findOnlyFile(nativeRoot, target.tauri.extension);
}

export async function packageAll({
  projectRoot = defaultProjectRoot,
  environment = process.env,
  platform = process.platform,
  runtimeBuilders = { electron: buildElectron, tauri: buildTauri },
} = {}) {
  if (typeof runtimeBuilders?.electron !== 'function' || typeof runtimeBuilders?.tauri !== 'function') {
    throw new TypeError('Release packaging requires Electron and Tauri runtime builders');
  }
  const targets = releaseTargetsForPlatform(platform);
  const { version } = await readReleaseConfiguration(projectRoot);
  const buildTime = environment.RELEASE_BUILD_TIME ?? formatBuildTime();
  requireReleaseToken(buildTime, 'build time', BUILD_TIME_PATTERN);
  const directories = await cleanArtifactDirectories({ projectRoot });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ineed-mqtt-release-'));
  const releaseEnvironment = { ...environment, RELEASE_BUILD_TIME: buildTime };

  try {
    const manifests = [];
    for (const target of targets) {
      for (const runtime of ['electron', 'tauri']) {
        const nativeRoot = path.join(temporaryRoot, runtime, target.architecture);
        await mkdir(nativeRoot, { recursive: true });
        const source = await runtimeBuilders[runtime]({
          projectRoot,
          nativeRoot,
          environment: releaseEnvironment,
          target,
        });
        const destination = path.join(
          directories[runtime],
          releaseArtifactName({ runtime, version, buildTime, target }),
        );
        await copyFile(source, `${destination}.partial`, constants.COPYFILE_EXCL);
        await rename(`${destination}.partial`, destination);
        manifests.push(await writeRuntimeManifest({
          directory: directories[runtime],
          runtime,
          artifactPath: destination,
          version,
          buildTime,
          target,
        }));
      }
    }
    return { version, buildTime, targets, manifests };
  } catch (error) {
    await Promise.all(Object.values(directories).map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  packageAll()
    .then(({ version, buildTime, targets }) => {
      const matrix = targets.map((target) => `${target.platform}-${target.architecture}`).join(', ');
      process.stdout.write(`Packaged ${PRODUCT_NAME} ${version} for ${matrix} at ${buildTime}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
