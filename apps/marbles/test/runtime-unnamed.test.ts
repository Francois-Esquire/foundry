/**
 * Code that names no workspace and no engine (`authoring/runtime.ts`), in
 * a process of its own: it reaches the one engine hosted here, and is
 * refused while two engines of that workspace are alive, rather than
 * handed to the one bound last.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { dispose, instanceRuntime, setHost } from "~/authoring/runtime";
import { startEngine } from "./helpers/engine";

afterEach(async () => {
  await dispose();
});

it("reaches the one engine alive for the one workspace hosted, and is refused while two are", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-unnamed-"));
  const workspaceId = "unnamed";
  const old = await startEngine({ print: () => undefined, root, workspaceId });
  const next = await startEngine({ print: () => undefined, root, workspaceId });
  try {
    setHost(old, new Catalog());
    expect(await instanceRuntime()).toBe(old);
    setHost(next, new Catalog());
    await expect(instanceRuntime()).rejects.toThrow(
      expect.objectContaining({ name: "AmbiguousWorkspaceError" })
    );
    await old.dispose();
    expect(await instanceRuntime()).toBe(next);
  } finally {
    await old.dispose();
    await next.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
