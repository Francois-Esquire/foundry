import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { expect, test } from "vitest";

test("every story renders and releases its key listeners", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { BoxRenderable } from "@opentui/core";
    import { createTestRenderer } from "@opentui/core/testing";
    import { Glob } from "bun";
    import { buildRegistry } from "textbook-sh";

    const pattern = "stories/**/*.stories.tsx";
    const files = [...new Glob(pattern).scanSync(".")];
    const skipped = [];
    console.warn = (...parts) => skipped.push(parts.join(" "));
    console.error = (...parts) => skipped.push(parts.join(" "));
    const registry = await buildRegistry({ pattern });
    assert.deepEqual(skipped, [], "every story file loads");
    assert.equal(registry.groups.length, files.length, "one group per story file");

    const ui = await createTestRenderer({ height: 50, width: 170 });
    const { renderer } = ui;
    const canvas = new BoxRenderable(renderer, { width: "100%", height: "100%" });
    renderer.root.add(canvas);
    const failures = [];

    try {
      for (const group of registry.groups) {
        assert.ok(group.stories.length > 0, group.title + " has stories");
        for (const story of group.stories) {
          const name = group.title + " / " + story.name;
          const listeners = renderer.keyInput.listenerCount("keypress");
          try {
            const mounted = await story.render(renderer);
            canvas.add(mounted);
            await ui.renderOnce();
            const blank = ui.captureCharFrame().trim() === "";
            canvas.remove(mounted);
            mounted.destroyRecursively();
            if (blank) {
              failures.push(name + ": blank frame");
            }
            if (renderer.keyInput.listenerCount("keypress") !== listeners) {
              failures.push(name + ": key listeners left behind");
            }
          } catch (error) {
            failures.push(name + ": " + String(error));
          }
        }
      }
    } finally {
      renderer.destroy();
    }

    assert.deepEqual(failures, []);
    assert.deepEqual(skipped, [], "no story logs warnings or errors");
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
}, 120_000);
