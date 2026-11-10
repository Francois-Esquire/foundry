/**
 * Prepares the font engine for the browser: copies the Pyodide runtime out of
 * node_modules and downloads the pinned fontTools and Brotli wheels named in
 * Pyodide's lock file, verifying each checksum. Output: public/engine.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const RUNTIME_FILES = [
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];
const WHEELS = ["fonttools", "brotli"];

interface LockedPackage {
  file_name: string;
  sha256: string;
}

const require = createRequire(import.meta.url);
const runtimeDir = path.dirname(require.resolve("pyodide/package.json"));
const { version } = JSON.parse(
  await readFile(path.join(runtimeDir, "package.json"), "utf8")
) as { version: string };
const lock = JSON.parse(
  await readFile(path.join(runtimeDir, "pyodide-lock.json"), "utf8")
) as {
  packages: Record<string, LockedPackage>;
};
const outDir = path.join(import.meta.dirname, "../public/engine");

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const exists = async (file: string) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const fetchWheel = async (name: string) => {
  const locked = lock.packages[name];
  if (!locked) {
    throw new Error(`Pyodide ${version} does not ship ${name}`);
  }
  const target = path.join(outDir, locked.file_name);
  if (
    (await exists(target)) &&
    digest(await readFile(target)) === locked.sha256
  ) {
    return;
  }
  const response = await fetch(
    `https://cdn.jsdelivr.net/pyodide/v${version}/full/${locked.file_name}`
  );
  if (!response.ok) {
    throw new Error(
      `Could not download ${locked.file_name}: ${response.status}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== locked.sha256) {
    throw new Error(`Checksum mismatch for ${locked.file_name}`);
  }
  await writeFile(target, bytes);
};

await mkdir(outDir, { recursive: true });
await Promise.all(
  RUNTIME_FILES.map((file) =>
    copyFile(path.join(runtimeDir, file), path.join(outDir, file))
  )
);
await Promise.all(WHEELS.map(fetchWheel));
console.log(
  `Font engine ready in ${path.relative(process.cwd(), outDir)} (Pyodide ${version})`
);
