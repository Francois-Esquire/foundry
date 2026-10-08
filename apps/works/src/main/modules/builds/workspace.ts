import type { SandboxFilesystemFacet } from "@foundry/sandbox/types";

const DERIVED_PACKAGE = /^packages\/[^/]+\/(?:generated|dist)(?:\/|$)/u;
function derived(path: string) {
  return (
    path
      .split("/")
      .some((part) => part === "node_modules" || part === ".turbo") ||
    DERIVED_PACKAGE.test(path)
  );
}

function knownSource(path: string, source: Record<string, string>) {
  return Object.hasOwn(source, path) || path === "bun.lock";
}

/** Build scripts may create derived files, but cannot add or rewrite authored source. */
export async function auditBuildWorkspace(
  files: Pick<SandboxFilesystemFacet, "readFile" | "list">,
  source: Record<string, string>,
  signal: AbortSignal
) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [path, expected] of Object.entries(source)) {
    signal.throwIfAborted();
    if (
      decoder.decode(await files.readFile(`/workspace/${path}`)) !== expected
    ) {
      throw new Error(
        `Build changed saved source: ${path}. Save the change before releasing.`
      );
    }
  }
  let count = 0;
  async function visit(path: string, depth: number) {
    signal.throwIfAborted();
    if (depth > 32) {
      throw new Error("Build workspace has too many nested directories");
    }
    for (const entry of await files.list(`/workspace/${path}`)) {
      count += 1;
      if (count > 8192) {
        throw new Error("Build workspace contains too many authored entries");
      }
      const relative = entry.path.slice("/workspace/".length);
      if (derived(relative)) {
        continue;
      }
      if (entry.type === "directory") {
        await visit(relative, depth + 1);
      } else if (entry.type !== "file" || !knownSource(relative, source)) {
        throw new Error(
          `Build emitted an undeclared source entry: ${relative}`
        );
      }
    }
  }
  await visit("", 0);
}
