import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { expect, test } from "vitest";
import { mountedReplays } from "../stories/views/replay-keys";

test("every replayed story reaches the state it describes", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { BoxRenderable } from "@opentui/core";
    import { createTestRenderer } from "@opentui/core/testing";
    import { buildRegistry } from "textbook-sh";

    const registry = await buildRegistry({ pattern: "stories/**/*.stories.tsx" });
    const { ${mountedReplays.name}: mountedReplays } = await import(
      "./stories/views/replay-keys.tsx"
    );
    const ui = await createTestRenderer({ height: 50, width: 170 });
    const { renderer } = ui;
    const canvas = new BoxRenderable(renderer, { width: "100%", height: "100%" });
    renderer.root.add(canvas);
    const failures = [];
    let replayed = 0;

    async function settle(deadline) {
      for (;;) {
        await ui.renderOnce();
        const frame = ui.captureCharFrame();
        const replays = mountedReplays();
        const reached = replays.every(
          (replay) => replay.done && frame.includes(replay.shows)
        );
        if (reached || Date.now() > deadline) {
          return { frame, replays };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    try {
      for (const group of registry.groups) {
        for (const story of group.stories) {
          const name = group.title + " / " + story.name;
          const mounted = await story.render(renderer);
          canvas.add(mounted);
          if (mountedReplays().length > 0) {
            replayed += 1;
            const { frame, replays } = await settle(Date.now() + 3000);
            for (const replay of replays) {
              if (!replay.done) {
                failures.push(name + ": the replay did not finish");
              } else if (!frame.includes(replay.shows)) {
                failures.push(name + ": the frame does not show " + JSON.stringify(replay.shows));
              }
            }
          }
          canvas.remove(mounted);
          mounted.destroyRecursively();
          if (mountedReplays().length > 0) {
            failures.push(name + ": the replay stayed mounted");
          }
        }
      }
    } finally {
      renderer.destroy();
    }

    assert.ok(replayed > 0, "some story replays keys");
    assert.deepEqual(failures, []);
    process.exit(0);
  `;
  const child = spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stderr: "pipe",
    stdout: "ignore",
  });
  const [exit, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
}, 180_000);
