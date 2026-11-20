import { gc, sleep } from "bun";
import { afterEach, expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import type { Current } from "~/lib/run-scope";
import { current } from "~/lib/run-scope";

afterEach(() => {
  catalog.reset();
});

async function collect(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await sleep(10);
    gc(true);
  }
}

it("keeps a definition made in a run answerable to its workspace without keeping the run", async () => {
  const frames: WeakRef<object>[] = [];
  for (let i = 0; i < 200; i += 1) {
    const frame = { bytes: new Uint8Array(10_000), i };
    frames.push(new WeakRef(frame));
    const store = {
      bindings: {
        context: { cwd: "/", environment: {}, workspaceId: "retention" },
      },
      frame,
    } as unknown as Current;
    current.run(store, () => step(`made-${String(i)}`).do(() => i));
  }
  await collect();
  expect(catalog.definitions.size).toBe(200);
  expect(frames.filter((frame) => frame.deref() !== undefined)).toHaveLength(0);
});
