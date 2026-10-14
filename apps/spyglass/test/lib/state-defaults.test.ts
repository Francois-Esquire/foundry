import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => sandbox.home,
}));
let directory: string;
let root: string;
let workspaceState: typeof import("../../src/lib/state").workspaceState;
beforeEach(async () => {
  directory = realpathSync(
    mkdtempSync(join(tmpdir(), "spyglass-default-state-"))
  );
  sandbox.home = join(directory, "home");
  root = join(directory, "workspace");
  mkdirSync(sandbox.home);
  mkdirSync(root);
  vi.resetModules();
  ({ workspaceState } = await import("../../src/lib/state"));
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));

it("uses the Spyglass state root for new workspaces without creating anything", async () => {
  const expected = await workspaceState(
    root,
    join(sandbox.home, ".foundry", "spyglass")
  );
  const current = await workspaceState(root);
  expect(current).toEqual(expected);
  expect(existsSync(current.directory)).toBe(false);
});
it("keeps an existing Atlas workspace's scans and locks in their original directory", async () => {
  const legacy = await workspaceState(
    root,
    join(sandbox.home, ".foundry", "atlas")
  );
  mkdirSync(legacy.directory, { recursive: true });
  expect(await workspaceState(root)).toEqual(legacy);
  expect(existsSync(join(sandbox.home, ".foundry", "spyglass"))).toBe(false);
});
it("prefers new state when present and never redirects an explicit state root", async () => {
  const current = await workspaceState(
    root,
    join(sandbox.home, ".foundry", "spyglass")
  );
  const legacy = await workspaceState(
    root,
    join(sandbox.home, ".foundry", "atlas")
  );
  mkdirSync(current.directory, { recursive: true });
  mkdirSync(legacy.directory, { recursive: true });
  expect(await workspaceState(root)).toEqual(current);
  const explicit = await workspaceState(root, join(directory, "custom"));
  expect(explicit.directory).toBe(join(directory, "custom", current.id));
});
