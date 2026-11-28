import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";

import { openHostDatabase } from "~/database/open";

vi.mock("~/database/open", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/database/open")>();
  return { ...original, openHostDatabase: vi.fn(original.openHostDatabase) };
});

it("keeps its recovery report over the one handle it opens for a state dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "create-handle-"));
  const lines: string[] = [];
  const engine = createEngine({
    catalog: new Catalog(),
    print: (line) => lines.push(line),
    providers: [],
    root: process.cwd(),
    stateDir,
    workspaceId: "ws",
  });
  try {
    await engine.start();
    await engine.stop();
    expect(lines.filter((line) => line.startsWith("[recovery]"))).toEqual([]);
    expect(vi.mocked(openHostDatabase)).toHaveBeenCalledTimes(1);
  } finally {
    await engine.dispose();
    await rm(stateDir, { force: true, recursive: true });
  }
});
