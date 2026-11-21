import { isDerivedBuildPath } from "@foundry/modules/build";
import {
  MODULE_SOURCE_LIMITS,
  type ModuleSourceLimits,
} from "@foundry/modules/source";
import type { Container } from "@foundry/sandbox/container/containers";
import { MODULE_SANDBOX_ROOT } from "../sandboxes/coordinator";
import { endAuthoringProcesses, giveWorkspaceToAuthor } from "./guest";

const MAX_DEPTH = 32;
const decoder = new TextDecoder("utf-8", { fatal: true });

type GuestFiles = Pick<Container, "commands" | "files">;

export async function seedWorkspace(
  container: GuestFiles,
  source: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<void> {
  await endAuthoringProcesses(container);
  const stale = (await container.files.list(MODULE_SANDBOX_ROOT)).map(
    (entry) => entry.path
  );
  if (stale.length > 0) {
    signal.throwIfAborted();
    const removed = await container.commands.exec(["rm", "-rf", ...stale], {
      signal,
    });
    if (removed.exitCode !== 0) {
      throw new Error("The sandbox workspace could not be cleared");
    }
  }
  signal.throwIfAborted();
  await container.files.copyIn(
    Object.fromEntries(
      Object.entries(source).map(([path, text]) => [
        `${MODULE_SANDBOX_ROOT}/${path}`,
        text,
      ])
    )
  );
  await giveWorkspaceToAuthor(container);
}

export async function collectWorkspace(
  container: GuestFiles,
  snapshot: Readonly<Record<string, string>>,
  signal: AbortSignal,
  effective: ModuleSourceLimits = MODULE_SOURCE_LIMITS
): Promise<Record<string, string>> {
  await endAuthoringProcesses(container);
  const authored = Object.keys(snapshot);
  const skipped = (path: string, directory: boolean) =>
    isDerivedBuildPath(path) &&
    !(directory
      ? authored.some((file) => file.startsWith(`${path}/`))
      : Object.hasOwn(snapshot, path));
  const limits = Object.fromEntries(
    Object.entries(MODULE_SOURCE_LIMITS).map(([key, ceiling]) => [
      key,
      Math.min(effective[key as keyof ModuleSourceLimits], ceiling),
    ])
  ) as ModuleSourceLimits;
  const files: Record<string, string> = {};
  let count = 0;
  let totalBytes = 0;
  const read = async (path: string) => {
    count += 1;
    if (count > limits.maxFiles) {
      throw new Error(`The workspace has more than ${limits.maxFiles} files`);
    }
    if (path.length > limits.maxPathCharacters) {
      throw new Error(
        `A source path is longer than ${limits.maxPathCharacters} characters`
      );
    }
    const maximum = Math.min(
      limits.maxBytes - totalBytes,
      limits.maxFileCodeUnits * 3
    );
    const result = await container.commands.exec(
      [
        "sh",
        "-c",
        `file=$(mktemp) || exit; trap 'rm -f -- "$file"' EXIT; head -c "$1" -- "$2" > "$file" && base64 -- "$file"`,
        "collect-source",
        String(maximum + 1),
        `${MODULE_SANDBOX_ROOT}/${path}`,
      ],
      { signal }
    );
    if (result.exitCode !== 0) {
      throw new Error(`The workspace file could not be read: ${path}`);
    }
    const bytes = new Uint8Array(Buffer.from(result.stdout, "base64"));
    if (bytes.byteLength > maximum) {
      throw new Error(
        `The workspace file exceeds its remaining source byte limit: ${path}`
      );
    }
    totalBytes += bytes.byteLength;
    try {
      const text = decoder.decode(bytes);
      if (text.length > limits.maxFileCodeUnits) {
        throw new Error(
          `${path} is longer than ${limits.maxFileCodeUnits} UTF-16 code units`
        );
      }
      files[path] = text;
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`The agent left a file that is not text: ${path}`, {
          cause: error,
        });
      }
      throw error;
    }
  };
  async function visit(directory: string, depth: number) {
    if (depth > MAX_DEPTH) {
      throw new Error("The workspace has too many nested directories");
    }
    for (const entry of await container.files.list(directory)) {
      signal.throwIfAborted();
      const path = entry.path.slice(`${MODULE_SANDBOX_ROOT}/`.length);
      if (skipped(path, entry.type === "directory")) {
        continue;
      }
      if (entry.type === "directory") {
        await visit(entry.path, depth + 1);
      } else if (entry.type === "file") {
        await read(path);
      } else {
        throw new Error(`The agent left a link or special file: ${path}`);
      }
    }
  }
  await visit(MODULE_SANDBOX_ROOT, 0);
  return files;
}
