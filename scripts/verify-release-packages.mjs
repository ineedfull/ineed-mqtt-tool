#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  APP_IDENTIFIER,
  PRODUCT_NAME,
  isForbiddenPackagePath,
  releaseArtifactName,
  releaseManifestName,
  releaseTargetsForPlatform,
} from './release-packaging.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..');
const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs', '.plist', '.toml', '.txt', '.xml', '.yaml', '.yml']);
const DEVELOPMENT_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/iu;
const SENSITIVE_MATERIAL = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;

function isContained(child, parent, allowEqual = false) {
  const relative = path.relative(parent, child);
  if (relative === '') return allowEqual;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function assertAllowedArtifactPath(filePath, {
  projectRoot = defaultProjectRoot,
  artifactRoot = path.join(projectRoot, 'artifacts'),
} = {}) {
  const canonicalProject = await realpath(projectRoot);
  const expectedInputRoot = path.resolve(projectRoot, 'artifacts');
  if (path.resolve(artifactRoot) !== expectedInputRoot) {
    throw new Error(`Artifact root must be the project artifacts directory: ${expectedInputRoot}`);
  }
  await mkdir(expectedInputRoot, { recursive: true });
  const rootMetadata = await lstat(expectedInputRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Artifact root must be a real directory: ${expectedInputRoot}`);
  }
  const canonicalArtifactRoot = await realpath(expectedInputRoot);
  if (!isContained(canonicalArtifactRoot, canonicalProject)) {
    throw new Error(`Artifact root must remain within the project: ${canonicalArtifactRoot}`);
  }
  const resolvedFile = path.resolve(filePath);
  if (!isContained(resolvedFile, expectedInputRoot)) {
    throw new Error(`Artifact path must remain within the artifacts directory: ${resolvedFile}`);
  }
  const runtime = path.relative(expectedInputRoot, resolvedFile).split(path.sep)[0];
  if (!['electron', 'tauri'].includes(runtime)) {
    throw new Error(`Artifact path must use an electron or tauri runtime directory: ${resolvedFile}`);
  }
  const existingParent = await realpath(path.dirname(resolvedFile));
  if (!isContained(existingParent, canonicalArtifactRoot, true)) {
    throw new Error(`Artifact path parent escapes the artifacts directory: ${resolvedFile}`);
  }
}

function normalizeEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function findForbiddenEntry(entries, textFiles = []) {
  for (const original of entries) {
    const entry = normalizeEntry(original);
    if (isForbiddenPackagePath(entry)) {
      return `Forbidden package entry: ${entry}`;
    }
  }
  for (const file of textFiles) {
    if (DEVELOPMENT_URL.test(file.contents)) {
      return `Development URL found in packaged file: ${file.path}`;
    }
    if (SENSITIVE_MATERIAL.test(file.contents)) {
      return `Sensitive material found in packaged file: ${file.path}`;
    }
  }
  return null;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function assertExactKeys(value, expected, description) {
  const keys = Object.keys(value).sort();
  assertArrayEqual(keys, [...expected].sort(), `${description} fields`);
}

function assertArrayEqual(actual, expected, description) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${description} differ: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
  }
}

async function readManifest(manifestPath, runtime) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${runtime} release manifest: ${manifestPath}`, { cause: error });
  }
  assertExactKeys(manifest, [
    'schemaVersion',
    'runtime',
    'product',
    'identifier',
    'version',
    'buildTime',
    'platform',
    'architecture',
    'artifact',
  ], `${runtime} manifest`);
  assertExactKeys(manifest.artifact ?? {}, ['name', 'size', 'sha256'], `${runtime} artifact manifest`);
  return manifest;
}

async function walkPackage(root) {
  const entries = [];
  const textFiles = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relativePath = path.relative(root, entryPath);
      entries.push(relativePath);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const metadata = await stat(entryPath);
        if (metadata.size <= 20 * 1024 * 1024) {
          textFiles.push({ path: relativePath, contents: await readFile(entryPath, 'utf8') });
        }
      }
    }
  }
  await visit(root);
  const violation = findForbiddenEntry(entries, textFiles);
  if (violation) throw new Error(violation);
  return entries.map(normalizeEntry);
}

async function run(command, args) {
  try {
    return await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const details = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Artifact inspection failed: ${command} ${args.join(' ')}${details ? `\n${details}` : ''}`, {
      cause: error,
    });
  }
}

async function findOnlyApp(mountPoint) {
  const entries = await readdir(mountPoint, { withFileTypes: true });
  const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (apps.length !== 1) throw new Error(`Expected exactly one .app in mounted package, found ${apps.length}`);
  return path.join(mountPoint, apps[0].name);
}

function expectedMachineArchitecture(target) {
  return target.architecture === 'arm64' ? /\barm64\b/u : /\bx86_64\b/u;
}

async function inspectDarwinDmg(artifactPath, { runtime, version, target }) {
  const artifactMetadata = await lstat(artifactPath);
  if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isFile() || artifactMetadata.size === 0) {
    throw new Error(`Artifact must be a real nonempty file: ${artifactPath}`);
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `mqtt-${runtime}-inspect-`));
  const mountPoint = path.join(temporaryRoot, 'mounted');
  await mkdir(mountPoint);
  let mounted = false;
  try {
    await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, artifactPath]);
    mounted = true;
    const appPath = await findOnlyApp(mountPoint);
    const contentsPath = path.join(appPath, 'Contents');
    const plistPath = path.join(contentsPath, 'Info.plist');
    const plistResult = await run('plutil', ['-convert', 'json', '-o', '-', plistPath]);
    let plist;
    try {
      plist = JSON.parse(plistResult.stdout);
    } catch (error) {
      throw new Error(`Invalid Info.plist JSON in ${artifactPath}`, { cause: error });
    }
    if (plist.CFBundleIdentifier !== APP_IDENTIFIER) {
      throw new Error(`${runtime} bundle identifier must equal ${APP_IDENTIFIER}`);
    }
    if (plist.CFBundleShortVersionString !== version) {
      throw new Error(`${runtime} bundle version must equal ${version}`);
    }
    const name = plist.CFBundleDisplayName ?? plist.CFBundleName;
    if (name !== PRODUCT_NAME) throw new Error(`${runtime} product name must equal ${PRODUCT_NAME}`);
    const executableName = plist.CFBundleExecutable;
    if (typeof executableName !== 'string' || path.basename(executableName) !== executableName) {
      throw new Error(`${runtime} bundle executable name is invalid`);
    }
    const executablePath = path.join(contentsPath, 'MacOS', executableName);
    const executableMetadata = await stat(executablePath);
    if (!executableMetadata.isFile() || executableMetadata.size === 0 || (executableMetadata.mode & 0o111) === 0) {
      throw new Error(`${runtime} native executable is missing or not executable`);
    }
    const fileResult = await run('file', ['-b', executablePath]);
    if (!/\bMach-O\b/u.test(fileResult.stdout) || !expectedMachineArchitecture(target).test(fileResult.stdout)) {
      throw new Error(`${runtime} native executable architecture does not match ${target.architecture}`);
    }

    const packageEntries = await walkPackage(appPath);
    let compiledRenderer = false;
    if (runtime === 'electron') {
      const appRoot = path.join(contentsPath, 'Resources', 'app');
      const required = [
        'dist/index.html',
        'electron/main.cjs',
        'electron/preload.cjs',
      ];
      for (const relativePath of required) {
        const metadata = await stat(path.join(appRoot, relativePath));
        if (!metadata.isFile() || metadata.size === 0) {
          throw new Error(`Electron package is missing ${relativePath}`);
        }
      }
      const distEntries = await walkPackage(path.join(appRoot, 'dist'));
      compiledRenderer = distEntries.some((entry) => entry.endsWith('.js'))
        && distEntries.some((entry) => entry.endsWith('.css'));
    } else {
      const resources = packageEntries.filter((entry) => entry.startsWith('Contents/Resources/'));
      if (resources.some((entry) => /\.(?:html|js|css)$/iu.test(entry))) {
        throw new Error('Tauri package must embed its compiled renderer in the native executable');
      }
      compiledRenderer = true;
    }
    if (!compiledRenderer) throw new Error(`${runtime} package does not contain a compiled renderer`);
    return { compiledRenderer, nativeRuntime: true, identifier: plist.CFBundleIdentifier };
  } finally {
    if (mounted) await run('hdiutil', ['detach', mountPoint]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function inspectReleaseArtifact(artifactPath, context) {
  if (context.target.platform === 'macos') return inspectDarwinDmg(artifactPath, context);
  throw new Error(`Fail-closed package inspection is not implemented for ${context.target.platform}`);
}

export async function verifyReleasePackages({
  projectRoot = defaultProjectRoot,
  expectedVersion,
  target,
  targets = target ? [target] : releaseTargetsForPlatform(),
  inspectArtifact = inspectReleaseArtifact,
} = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('Release verification requires at least one target');
  }
  const version = expectedVersion ?? JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
  const manifests = [];
  for (const runtime of ['electron', 'tauri']) {
    const directory = path.join(projectRoot, 'artifacts', runtime);
    const entries = (await readdir(directory)).sort();
    for (const releaseTarget of targets) {
      const manifestName = releaseManifestName(releaseTarget);
      if (!entries.includes(manifestName)) {
        throw new Error(`Missing ${runtime} release manifest for ${releaseTarget.platform}-${releaseTarget.architecture}`);
      }
    }
    const runtimeManifests = [];
    for (const releaseTarget of targets) {
      const manifestPath = path.join(directory, releaseManifestName(releaseTarget));
      await assertAllowedArtifactPath(manifestPath, { projectRoot });
      const manifest = await readManifest(manifestPath, runtime);
      const expectedName = releaseArtifactName({
        runtime,
        version,
        buildTime: manifest.buildTime,
        target: releaseTarget,
      });
      if (
        manifest.schemaVersion !== 1
        || manifest.runtime !== runtime
        || manifest.product !== PRODUCT_NAME
        || manifest.identifier !== APP_IDENTIFIER
        || manifest.version !== version
        || manifest.platform !== releaseTarget.platform
        || manifest.architecture !== releaseTarget.architecture
        || manifest.artifact.name !== expectedName
      ) {
        throw new Error(`${runtime} release manifest does not match the release contract`);
      }
      runtimeManifests.push({ manifest, expectedName, releaseTarget });
    }
    const expectedEntries = runtimeManifests.flatMap(({ expectedName, releaseTarget }) => [
      expectedName,
      releaseManifestName(releaseTarget),
    ]).sort();
    assertArrayEqual(entries, expectedEntries, `${runtime} unexpected artifact collection entry set`);

    for (const { manifest, expectedName, releaseTarget } of runtimeManifests) {
      const artifactPath = path.join(directory, expectedName);
      await assertAllowedArtifactPath(artifactPath, { projectRoot });
      const metadata = await stat(artifactPath);
      if (metadata.size === 0 || metadata.size !== manifest.artifact.size) {
        throw new Error(`${runtime} artifact size differs from its manifest`);
      }
      if (await sha256(artifactPath) !== manifest.artifact.sha256) {
        throw new Error(`${runtime} artifact SHA-256 differs from its manifest`);
      }
      const inspection = await inspectArtifact(artifactPath, { runtime, version, target: releaseTarget });
      if (
        inspection?.compiledRenderer !== true
        || inspection?.nativeRuntime !== true
        || inspection?.identifier !== APP_IDENTIFIER
      ) {
        throw new Error(`${runtime} artifact inspection did not prove renderer, native runtime, and identity`);
      }
      manifests.push(manifest);
    }
  }
  const buildTimes = new Set(manifests.map((manifest) => manifest.buildTime));
  if (buildTimes.size !== 1) {
    throw new Error('Electron and Tauri artifacts must share one build timestamp across every target');
  }
  return {
    version,
    buildTime: manifests[0].buildTime,
    targets: targets.map(({ platform, architecture }) => ({ platform, architecture })),
    runtimes: ['electron', 'tauri'],
    artifacts: manifests.map((manifest) => manifest.artifact),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  verifyReleasePackages()
    .then((result) => process.stdout.write(`RELEASE_PACKAGE_RESULT=${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
