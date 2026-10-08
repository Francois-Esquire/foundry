import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Artifacts, ContentId } from "@foundry/artifacts";
import type { StorageTree } from "@foundry/core/storage";

import type { ModuleVersion } from "../domain";
import type { ModuleCheckouts } from "../platform/files";

import { KeyedTurns } from "../platform/turns";

export type { ModuleCheckouts } from "../platform/files";

const OUTPUTS_PREFIX = "outputs/";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export class ModuleCheckoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleCheckoutError";
  }
}

export function createModuleCheckouts(options: {
  readonly root: string;
  readonly artifacts: Pick<Artifacts, "getContent" | "readFile">;
}): ModuleCheckouts {
  const root = path.resolve(options.root);
  const turns = new KeyedTurns<string>();
  const checkouts: ModuleCheckouts = {
    ensure: ({ version, signal }) =>
      turns.run(directoryName(version.digest), () => ensure(version, signal)),
  };
  return Object.freeze(checkouts);

  async function ensure(
    version: Pick<ModuleVersion, "contentId" | "digest">,
    signal?: AbortSignal
  ): Promise<{ readonly hostPath: string }> {
    signal?.throwIfAborted();
    const content = await options.artifacts.getContent(version.contentId);
    if (content?.state !== "frozen" || content.digest !== version.digest) {
      throw new ModuleCheckoutError(
        `Content ${version.contentId} does not match the selected version`
      );
    }
    const outputs = outputEntries(content.tree);
    if (!outputs.some(([, entry]) => entry.type === "file")) {
      throw new ModuleCheckoutError(
        `Content ${version.contentId} has no runnable outputs`
      );
    }
    await mkdir(root, { mode: 0o700, recursive: true });
    const hostPath = path.join(root, directoryName(version.digest));
    if (await exists(hostPath)) {
      if (await matches(hostPath, outputs)) {
        return { hostPath };
      }
      // A live VM may still hold the damaged tree; move it aside, never
      // rewrite it in place.
      await rename(hostPath, path.join(root, `.corrupt-${randomUUID()}`));
    }

    // Filled beside its final name and published by one rename, so a
    // concurrent start of the same digest never sees a partial tree.
    const temporary = path.join(root, `.tmp-${randomUUID()}`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeOutputs(temporary, content.id, outputs, signal);
      await chmod(temporary, 0o755);
      try {
        await rename(temporary, hostPath);
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          throw error;
        }
        if (!(await matches(hostPath, outputs))) {
          throw new ModuleCheckoutError(
            `Checkout ${hostPath} was published concurrently and failed verification`,
            { cause: error }
          );
        }
      }
    } finally {
      await rm(temporary, { force: true, recursive: true }).catch(
        () => undefined
      );
    }
    return { hostPath };
  }

  /** Writes every output entry under `temporary`, verifying each file's bytes. */
  async function writeOutputs(
    temporary: string,
    contentId: ContentId,
    outputs: readonly OutputEntry[],
    signal: AbortSignal | undefined
  ): Promise<void> {
    for (const [filePath, entry] of outputs) {
      signal?.throwIfAborted();
      const target = path.join(temporary, filePath);
      if (entry.type === "directory") {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (entry.type !== "file") {
        throw new ModuleCheckoutError(
          `Module output ${JSON.stringify(filePath)} is a ${entry.type}`
        );
      }
      const file = await options.artifacts.readFile(contentId, filePath);
      if (file === null || sha256(file.blob) !== entry.digest) {
        throw new ModuleCheckoutError(
          `Module output ${JSON.stringify(filePath)} failed byte verification`
        );
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.blob, { mode: 0o444 });
    }
  }
}

type OutputEntry = readonly [string, StorageTree[string]];

function outputEntries(tree: StorageTree): readonly OutputEntry[] {
  const outputs = Object.entries(tree)
    .filter(([filePath]) => filePath.startsWith(OUTPUTS_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [filePath, entry] of outputs) {
    if (
      filePath.includes("\\") ||
      filePath.includes("\0") ||
      filePath
        .split("/")
        .some((part) => part === ".." || part === "." || part === "") ||
      (entry.type !== "file" && entry.type !== "directory")
    ) {
      throw new ModuleCheckoutError(
        `Unsupported Module output ${JSON.stringify(filePath)}`
      );
    }
  }
  return outputs;
}

/** Exactly the Content's output tree, with byte-verified files. */
async function matches(
  hostPath: string,
  outputs: readonly OutputEntry[]
): Promise<boolean> {
  const metadata = await lstat(hostPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return false;
  }
  const expected = new Map<string, string | null>();
  for (const [filePath, entry] of outputs) {
    expected.set(filePath, entry.type === "file" ? entry.digest : null);
    let parent = path.posix.dirname(filePath);
    while (parent !== ".") {
      expected.set(parent, null);
      parent = path.posix.dirname(parent);
    }
  }
  const found = await listFiles(hostPath, "");
  if (found?.length !== expected.size) {
    return false;
  }
  for (const [filePath, directory] of found) {
    const digest = expected.get(filePath);
    if (
      digest === undefined ||
      (directory
        ? digest !== null
        : digest === null ||
          sha256(await readFile(path.join(hostPath, filePath))) !== digest)
    ) {
      return false;
    }
  }
  return true;
}

/** `null` when the tree holds anything but real files and directories. */
async function listFiles(
  root: string,
  relative: string
): Promise<[string, boolean][] | null> {
  const files: [string, boolean][] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await listFiles(root, next);
      if (nested === null) {
        return null;
      }
      files.push([next, true], ...nested);
    } else if (entry.isFile()) {
      files.push([next, false]);
    } else {
      return null;
    }
  }
  return files;
}

function directoryName(digest: string): string {
  return SHA256_HEX.test(digest) ? digest : sha256(digest);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  return (
    (await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    })) !== undefined
  );
}
