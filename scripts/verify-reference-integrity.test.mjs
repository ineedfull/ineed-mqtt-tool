import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "verify-reference-integrity.sh");

async function put(root, relativePath, contents) {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

function run(args) {
  return spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
  });
}

function parseManifest(contents) {
  return contents.trim().split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64}) {2}(\.\/.+)$/);
    assert.ok(match, `invalid SHA-256 manifest entry: ${line}`);
    return { digest: match[1], path: match[2] };
  });
}

test("writes portable manifests and detects reference drift", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "mqtt-reference-integrity-"));
  const electronRoot = join(fixture, "electron");
  const tauriRoot = join(fixture, "tauri");
  const manifestDir = join(fixture, "manifests");

  try {
    await put(electronRoot, "src/main.txt", "electron source\n");
    await put(electronRoot, "target/included.txt", "electron target is included\n");
    await put(tauriRoot, "src-tauri/main.rs", "fn main() {}\n");

    for (const excluded of [".git", "node_modules", "dist", "release"]) {
      await put(electronRoot, `${excluded}/excluded-${excluded}.txt`, "excluded\n");
      await put(tauriRoot, `${excluded}/excluded-${excluded}.txt`, "excluded\n");
    }
    await put(tauriRoot, "target/excluded-target.txt", "excluded\n");

    const writeResult = run(["--write", electronRoot, tauriRoot, manifestDir]);
    assert.equal(writeResult.status, 0, writeResult.stderr);

    const electronText = await readFile(join(manifestDir, "electron.sha256"), "utf8");
    const tauriText = await readFile(join(manifestDir, "tauri.sha256"), "utf8");
    const electronEntries = parseManifest(electronText);
    const tauriEntries = parseManifest(tauriText);

    assert.deepEqual(electronEntries.map(({ path }) => path), [
      "./src/main.txt",
      "./target/included.txt",
    ]);
    assert.deepEqual(tauriEntries.map(({ path }) => path), ["./src-tauri/main.rs"]);
    assert.doesNotMatch(electronText + tauriText, /\/Users\/|excluded/);

    const verifyResult = run([electronRoot, tauriRoot, manifestDir]);
    assert.equal(verifyResult.status, 0, verifyResult.stderr);

    await put(electronRoot, "src/main.txt", "mutated electron source\n");
    const driftResult = run([electronRoot, tauriRoot, manifestDir]);
    assert.notEqual(driftResult.status, 0, "mutation must fail verification");

    const invalidRootResult = run([join(fixture, "missing"), tauriRoot, manifestDir]);
    assert.notEqual(invalidRootResult.status, 0, "invalid reference root must fail");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
