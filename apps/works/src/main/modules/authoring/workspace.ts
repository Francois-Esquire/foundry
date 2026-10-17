import { parseModuleManifestSourceText } from "@foundry/modules/manifest";
import type { Container } from "@foundry/sandbox/container/containers";
import type { ProposalFiles } from "~/shared/authoring";
import { derived } from "../builds/workspace";
import { MODULE_SANDBOX_ROOT } from "../sandboxes/coordinator";
import {
  admitSource,
  SOURCE_LIMITS,
  type SourceLimits,
} from "../source-admission";
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
    derived(path) &&
    !(directory
      ? authored.some((file) => file.startsWith(`${path}/`))
      : Object.hasOwn(snapshot, path));
  const files: Record<string, string> = {};
  let count = 0;
  const read = async (path: string) => {
    count += 1;
    if (count > SOURCE_LIMITS.maxFiles) {
      throw new Error(
        `The workspace has more than ${SOURCE_LIMITS.maxFiles} files`
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

/** Each path whose collected file differs from the snapshot; `null` where it was removed. */
export function proposedChanges(
  snapshot: Readonly<Record<string, string>>,
  collected: Readonly<Record<string, string>>
): ProposalFiles {
  const changes: ProposalFiles = {};
  for (const path of new Set([
    ...Object.keys(snapshot),
    ...Object.keys(collected),
  ])) {
    const after = Object.hasOwn(collected, path) ? collected[path] : null;
    const before = Object.hasOwn(snapshot, path) ? snapshot[path] : null;
    if (after !== before) {
      changes[path] = after ?? null;
    }
  }
  return changes;
}

/** `source` with `changes` applied: `null` removes a file. */
function withChanges(
  source: Readonly<Record<string, string>>,
  changes: ProposalFiles
): Record<string, string> {
  const next = { ...source };
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) {
      delete next[path];
    } else {
      next[path] = value;
    }
  }
  return next;
}

/**
 * Admit a proposal the way saved source is admitted: portable paths and the
 * source limits over the files it would produce, and a Manifest that still
 * parses when the proposal changes it.
 */
export function validateProposal(
  snapshot: Readonly<Record<string, string>>,
  changes: ProposalFiles,
  limits: SourceLimits = SOURCE_LIMITS
): void {
  const result = withChanges(snapshot, changes);
  admitSource(result, limits);
  if (Object.hasOwn(changes, "foundry.module.json")) {
    const manifest = changes["foundry.module.json"];
    if (typeof manifest !== "string") {
      throw new Error("The proposal removes foundry.module.json.");
    }
    try {
      parseModuleManifestSourceText(manifest);
    } catch (error) {
      throw new Error(
        `The proposed foundry.module.json is not a valid Manifest: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}
