import { gc, sleep } from "bun";
import { expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { Catalog } from "~/authoring/catalog";
import type { Current } from "~/lib/runs/scope";
import { current } from "~/lib/runs/scope";

async function collect(frames: readonly WeakRef<object>[]): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    await sleep(10);
    gc(true);
    if (frames.every((frame) => frame.deref() === undefined)) {
      return;
    }
  }
}

function definitionsInRuns() {
  const frames: WeakRef<object>[] = [];
  const definitions: ReturnType<ReturnType<typeof step>["do"]>[] = [];
  for (let i = 0; i < 200; i += 1) {
    const frame = { bytes: new Uint8Array(10_000), i };
    frames.push(new WeakRef(frame));
    const store = {
      bindings: {
        context: { cwd: "/", environment: {}, workspaceId: "retention" },
      },
      frame,
    } as unknown as Current;
    definitions.push(
      current.run(store, () => step(`made-${String(i)}`).do(() => i))
    );
  }
  return { collected: Catalog.collect(definitions), frames };
}

it("keeps a definition made in a run answerable to its workspace without keeping the run", async () => {
  const { collected, frames } = definitionsInRuns();
  await collect(frames);
  expect(collected.definitions.size).toBe(200);
  expect(frames.filter((frame) => frame.deref() !== undefined)).toHaveLength(0);
});
