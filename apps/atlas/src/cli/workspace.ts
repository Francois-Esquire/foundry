import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function resolveWorkspace(
  target: string,
  state = join(homedir(), ".foundry", "atlas")
) {
  const root = await realpath(resolve(target));
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  const id = createHash("sha256").update(root).digest("hex");
  const directory = join(resolve(state), id);
  return {
    cache: join(directory, "cache"),
    output: join(directory, "output"),
    root,
  };
}
