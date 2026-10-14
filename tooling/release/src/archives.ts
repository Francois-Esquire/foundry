import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface ReleaseArchives {
  tarball: string;
  zip: string;
}

const VERSION_FILENAME =
  /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

function readIdentity(root: string) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (
    typeof manifest.name !== "string" ||
    manifest.private === true ||
    typeof manifest.version !== "string" ||
    !VERSION_FILENAME.test(manifest.version)
  ) {
    throw new Error("Expected a public, versioned package");
  }
  return { name: manifest.name as string, version: manifest.version as string };
}

function inventory(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(`Unexpected non-file in package: ${entry.name}`);
      }
      const path = join(entry.parentPath, entry.name);
      const name = path.slice(root.length + 1);
      return {
        // File type bits are irrelevant; compare the archived permission bits.
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission mask
        mode: statSync(path).mode & 0o777,
        name,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function verifyReleaseArchives(archives: ReleaseArchives) {
  const staging = mkdtempSync(join(tmpdir(), "release-verify-"));
  try {
    const tarRoot = join(staging, "tar");
    const zipRoot = join(staging, "zip");
    mkdirSync(tarRoot);
    run("tar", ["-xzf", resolve(archives.tarball), "-C", tarRoot], staging);
    run("unzip", ["-q", resolve(archives.zip), "-d", zipRoot], staging);
    for (const root of [tarRoot, zipRoot]) {
      if (!isDeepStrictEqual(readdirSync(root), ["package"])) {
        throw new Error("Archives must contain only the package directory");
      }
    }
    const tarFiles = inventory(join(tarRoot, "package"));
    const zipFiles = inventory(join(zipRoot, "package"));
    if (!isDeepStrictEqual(tarFiles, zipFiles)) {
      throw new Error("Archive contents differ (paths, bytes, or permissions)");
    }
    const identity = readIdentity(join(tarRoot, "package"));
    return { ...identity, files: tarFiles.map(({ name }) => name) };
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export function createZipArchive(tarball: string, destination: string): void {
  const staging = mkdtempSync(join(tmpdir(), "release-zip-"));
  try {
    run("tar", ["-xzf", resolve(tarball)], staging);
    const zip = join(staging, "archive.zip");
    run("zip", ["-q", "-r", "-X", zip, "package"], staging);
    copyFileSync(zip, destination);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export function createReleaseArchives(
  packageRoot: string,
  destination = join(packageRoot, ".cache/release-assets")
): ReleaseArchives {
  const identity = readIdentity(packageRoot);
  const staging = mkdtempSync(join(tmpdir(), "release-pack-"));
  try {
    run(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--destination", staging],
      packageRoot
    );
    const packed = readdirSync(staging).filter((name) => name.endsWith(".tgz"));
    if (packed.length !== 1 || !packed[0]) {
      throw new Error("Expected one packed npm archive");
    }
    const [filename] = packed;
    const archives = {
      tarball: join(staging, filename),
      zip: join(staging, `${filename.slice(0, -4)}.zip`),
    };
    createZipArchive(archives.tarball, archives.zip);
    const verified = verifyReleaseArchives(archives);
    if (
      verified.name !== identity.name ||
      verified.version !== identity.version
    ) {
      throw new Error("Packed identity differs from the package manifest");
    }
    const [npmPack] = JSON.parse(
      run(
        "npm",
        [
          "pack",
          "--dry-run",
          "--ignore-scripts",
          "--json",
          "--cache",
          join(staging, "npm-cache"),
        ],
        packageRoot
      )
    ) as { files: { path: string }[]; name: string; version: string }[];
    if (
      npmPack?.name !== identity.name ||
      npmPack.version !== identity.version
    ) {
      throw new Error("npm pack selected a different package identity");
    }
    const npmFiles = npmPack?.files.map(({ path }) => path).sort();
    if (!isDeepStrictEqual([...verified.files].sort(), npmFiles)) {
      throw new Error("Bun and npm pack selected different package files");
    }
    mkdirSync(destination, { recursive: true });
    const result = {
      tarball: join(destination, basename(archives.tarball)),
      zip: join(destination, basename(archives.zip)),
    };
    copyFileSync(archives.tarball, result.tarball);
    copyFileSync(archives.zip, result.zip);
    return result;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}
