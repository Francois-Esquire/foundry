import { isDerivedBuildPath } from "@foundry/modules/build";
import { MODULE_SOURCE_LIMITS } from "@foundry/modules/source";
import type { Container } from "@foundry/sandbox/container/containers";
import { MODULE_SANDBOX_ROOT } from "../sandboxes/coordinator";
import { endAuthoringProcesses, giveWorkspaceToAuthor } from "./guest";

/**
 * A turn's scratch copy of the Draft in its Module sandbox. The agent's
 * coding tools work in the sandbox workspace root, which holds nothing
 * else: builds keep their directories outside it. The workspace belongs to
 * the authoring guest user; root seeds and collects it only once nothing
 * that user started is still running.
 */

const MAX_DEPTH = 32;
const decoder = new TextDecoder("utf-8", { fatal: true });

type GuestFiles = Pick<Container, "commands" | "files">;

/** Replace what an earlier turn left in the workspace with the Draft snapshot. */
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

/**
 * The authored files the turn left in the workspace, read into memory.
 * Installed and generated files are left out, except where the snapshot
 * itself carries them (a Module may author files under a package's dist).
 */
export async function collectWorkspace(
  container: GuestFiles,
  snapshot: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<Record<string, string>> {
  await endAuthoringProcesses(container);
  const authored = Object.keys(snapshot);
  const skipped = (path: string, directory: boolean) =>
    isDerivedBuildPath(path) &&
    !(directory
      ? authored.some((file) => file.startsWith(`${path}/`))
      : Object.hasOwn(snapshot, path));
  const files: Record<string, string> = {};
  let count = 0;
  const read = async (path: string) => {
    count += 1;
    if (count > MODULE_SOURCE_LIMITS.maxFiles) {
      throw new Error(
        `The workspace has more than ${MODULE_SOURCE_LIMITS.maxFiles} files`
      );
    }
    try {
      files[path] = decoder.decode(
        await container.files.readFile(`${MODULE_SANDBOX_ROOT}/${path}`)
      );
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
