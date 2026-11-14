import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileMapScanner } from "../../src/lib/file-map-scanner";
import {
  loadHeldSpyglass,
  loadImports,
  loadLateReadings,
} from "../../src/web/layout/load-spyglass";

const NOW = new Date("2026-11-09T00:00:00.000Z");

const files = {
  "package.json": JSON.stringify({
    name: "held",
    private: true,
    workspaces: ["packages/*"],
  }),
  "packages/a/package.json": JSON.stringify({ name: "@held/a" }),
  "packages/a/src/index.ts": "export const a = 1;\n",
  "packages/b/package.json": JSON.stringify({ name: "@held/b" }),
  "packages/b/src/index.ts":
    'import { a } from "@held/a";\nexport const b = a;\n',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a held dataset in the viewer", () => {
  it("lays out and reads every later reading through its own transport", async () => {
    const fetch = vi.fn(() => {
      throw new Error("a held dataset must not be fetched");
    });
    vi.stubGlobal("fetch", fetch);
    const dataset = await createFileMapScanner().scan({
      files,
      now: NOW,
      root: "/github/octo/held",
    });
    const data = await loadHeldSpyglass(dataset.transport);
    expect(data.territories.map((territory) => territory.id).sort()).toEqual([
      "@held/a",
      "@held/b",
    ]);
    const [frame] = data.frames;
    expect(frame?.dataset.transport).toBe(dataset.transport);
    expect(frame?.dataset.generatedAt).toBe(
      (await dataset.reader().manifest()).generatedAt
    );
    await loadLateReadings(data);
    expect(await loadImports(data)).toContainEqual({
      source: "packages/b/src/index.ts",
      target: "packages/a/src/index.ts",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a later reading once its scan's dataset has been replaced", async () => {
    const first = await createFileMapScanner().scan({
      files,
      now: NOW,
      root: "/github/octo/held",
    });
    const data = await loadHeldSpyglass(first.transport);
    const second = await createFileMapScanner().scan({
      files,
      now: new Date("2026-11-10T00:00:00.000Z"),
      root: "/github/octo/held",
    });
    const [frame] = data.frames;
    if (frame === undefined) {
      throw new Error("expected one frame");
    }

    const swapped = {
      ...data,
      frames: [
        {
          ...frame,
          dataset: { ...frame.dataset, transport: second.transport },
        },
      ],
    };
    await expect(loadLateReadings(swapped)).rejects.toThrow(
      "A later scan replaced this dataset."
    );
  });
});
