import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { expect, test } from "vitest";

test("mounting and restarting the splash story preserves the workshop", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { BoxRenderable } from "@opentui/core";
    import { createTestRenderer } from "@opentui/core/testing";
    import { Ready } from "./stories/splash.stories";

    const ui = await createTestRenderer({ height: 24, width: 80 });
    const { renderer } = ui;
    const canvas = new BoxRenderable(renderer, { width: "100%", height: "100%" });
    renderer.root.add(canvas);
    const initialListeners = renderer.keyInput.listenerCount("keypress");

    try {
      for (let visit = 0; visit < 2; visit += 1) {
        const story = await Ready.render(renderer);
        assert.equal(canvas.parent === renderer.root, true, "workshop stays mounted");
        canvas.add(story);
        await ui.renderOnce();
        assert.match(ui.captureCharFrame(), /Press Enter to enter/);
        canvas.remove(story);
        story.destroyRecursively();
        assert.equal(renderer.keyInput.listenerCount("keypress"), initialListeners);
      }
    } finally {
      renderer.destroy();
    }
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
});
