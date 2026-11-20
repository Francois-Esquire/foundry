import { isPortableRelativePath } from "./manifest";

const DERIVED_PACKAGE_PATH = /^packages\/[^/]+\/(?:generated|dist)(?:\/|$)/u;
const OUTPUT_PATH = /^packages\/[^/]+\/dist\/.+/u;
const MAX_AUDITED_ENTRIES = 8192;
const MAX_AUDITED_DEPTH = 32;

export function isDerivedBuildPath(path: string): boolean {
  return (
    path
      .split("/")
      .some((part) => part === "node_modules" || part === ".turbo") ||
    DERIVED_PACKAGE_PATH.test(path)
  );
}

export function isModuleBuildOutputPath(path: string): boolean {
  return isPortableRelativePath(path) && OUTPUT_PATH.test(path);
}

export interface ModuleBuildWorkspace {
  list(
    path: string
  ): Promise<readonly { readonly path: string; readonly type: string }[]>;
  readFile(path: string): Promise<Uint8Array>;
}

export async function auditModuleBuildWorkspace(
  workspace: ModuleBuildWorkspace,
  source: Readonly<Record<string, string>>,
  signal: AbortSignal,
  root: string
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [path, expected] of Object.entries(source)) {
    signal.throwIfAborted();
    if (
      decoder.decode(await workspace.readFile(`${root}/${path}`)) !== expected
    ) {
      throw new Error(
        `Build changed saved source: ${path}. Save the change before releasing.`
      );
    }
  }
  const authored = (path: string) =>
    Object.hasOwn(source, path) || path === "bun.lock";
  let count = 0;
  async function visit(path: string, depth: number) {
    signal.throwIfAborted();
    if (depth > MAX_AUDITED_DEPTH) {
      throw new Error("Build workspace has too many nested directories");
    }
    for (const entry of await workspace.list(`${root}/${path}`)) {
      count += 1;
      if (count > MAX_AUDITED_ENTRIES) {
        throw new Error("Build workspace contains too many authored entries");
      }
      const relative = entry.path.slice(`${root}/`.length);
      if (isDerivedBuildPath(relative)) {
        continue;
      }
      if (entry.type === "directory") {
        await visit(relative, depth + 1);
      } else if (entry.type !== "file" || !authored(relative)) {
        throw new Error(
          `Build emitted an undeclared source entry: ${relative}`
        );
      }
    }
  }
  await visit("", 0);
}
