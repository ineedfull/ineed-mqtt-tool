/* global process */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeRendererDependencyIdentity } from './visualInfrastructure.mjs';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function listFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (relative === 'metadata.json') return [];
    return entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), relative)
      : [relative];
  }));
  return nested.flat().sort();
}

export async function generateManagedReferenceMetadata({
  fixtureRoot,
  manifestPath,
  referenceLockPath,
}) {
  const manifest = await readFile(manifestPath, 'utf8');
  const dependencyIdentity = computeRendererDependencyIdentity(await readFile(referenceLockPath, 'utf8'));
  const artifacts = [];
  for (const relativePath of await listFiles(fixtureRoot)) {
    const contents = await readFile(path.join(fixtureRoot, relativePath));
    artifacts.push({ path: relativePath, sha256: sha256(contents), size: contents.length });
  }
  const metadata = {
    version: 1,
    artifacts,
    build: {
      command: 'npm run build -- --outDir <managed-fixture> --emptyOutDir',
      dependencyMode: 'temporary-npm-ci --ignore-scripts',
    },
    dependencies: {
      closureSha256: dependencyIdentity.closureSha256,
      lockSha256: dependencyIdentity.lockSha256,
      packageCount: dependencyIdentity.packageCount,
    },
    source: {
      entryCount: manifest.trim().split('\n').length,
      manifest: 'docs/verification/reference-manifests/electron.sha256',
      manifestSha256: sha256(manifest),
    },
  };
  await writeFile(path.join(fixtureRoot, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [fixtureRoot, manifestPath, referenceLockPath] = process.argv.slice(2);
  if (!fixtureRoot || !manifestPath || !referenceLockPath) {
    throw new Error('Usage: node generateManagedReferenceFixture.mjs <fixture-root> <manifest> <reference-lock>');
  }
  await generateManagedReferenceMetadata({ fixtureRoot, manifestPath, referenceLockPath });
}
