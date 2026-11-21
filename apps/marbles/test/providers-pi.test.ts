import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { piPlugin } from "~/lib/providers/plugins";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("searches only the configured PATH for Pi, not the host's", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-absent-"));
  writeFileSync(join(root, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  vi.stubEnv("PATH", root);
  try {
    const env = {};
    expect(piPlugin.detect?.({ env })).toBeNull();
    const built = piPlugin.create({
      env,
      id: "pi",
      models: [],
      scope: "machine",
      settings: {},
    });
    expect(built.execution?.bin).toBeUndefined();
    expect(built.provider.available).toBe(false);
    await built.provider.dispose?.();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("finds Pi on the PATH the environment gives", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-present-"));
  writeFileSync(join(root, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    const env = { PATH: root };
    expect(piPlugin.detect?.({ env })).toEqual({});
    const built = piPlugin.create({
      env,
      id: "pi",
      models: [],
      scope: "machine",
      settings: {},
    });
    expect(built.execution?.bin).toBe(join(root, "pi"));
    await built.provider.dispose?.();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
