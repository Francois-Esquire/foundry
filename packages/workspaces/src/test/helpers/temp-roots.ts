import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { nodeFileSystem } from "../../node";
import type { WorkspaceStore } from "../../store";
import { directorySystem } from "./directory-system";

export const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

export async function makeRoot(
  tree: Record<string, string | Uint8Array>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "foundry-workspace-system-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return await nodeFileSystem.realpath(root);
}

export function systemOver(store: WorkspaceStore) {
  return directorySystem({ store });
}
