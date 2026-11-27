import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { claudeCode } from "~/lib/providers/claude-code";
import { codex } from "~/lib/providers/codex";
import { pi } from "~/lib/providers/pi";

vi.mock("~/lib/providers/installed", () => ({
  providerInstalled: () => false,
}));

it("does not offer or enable CLI providers whose adapters are absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-no-adapters-"));
  try {
    for (const name of ["claude", "codex", "pi"]) {
      writeFileSync(join(root, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    const env = { PATH: root };
    for (const plugin of [claudeCode, codex, pi]) {
      expect(plugin.detect?.({ env })).toBeNull();
      const instance = plugin.create({
        env,
        id: plugin.id,
        models: [{ id: "test", kind: "text", modelId: "test" }],
        scope: "machine",
        settings: {},
      });
      expect(instance.provider.available).toBe(false);
      if (plugin.list) {
        expect(
          await plugin.list({
            env,
            settings: {},
            signal: new AbortController().signal,
          })
        ).toEqual([]);
      }
      await instance.provider.dispose?.();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
