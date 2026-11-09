import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_CODE, CODEX, PI, selectExecutor, which } from "~/lib/harnesses";
import { mockModels } from "~/lib/models/echo";

const NO_PROVIDER = /No configured model provider is available/;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true });
  }
});

describe("which", () => {
  it("returns the first executable on PATH, skipping non-executables", () => {
    const root = mkdtempSync(join(tmpdir(), "marbles-path-"));
    dirs.push(root);
    const plain = join(root, "plain");
    const bin = join(root, "bin");
    mkdirSync(plain);
    mkdirSync(bin);
    writeFileSync(join(plain, "codex"), "");
    chmodSync(join(plain, "codex"), 0o644);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);

    const path = ["", plain, bin].join(delimiter);
    expect(which("codex", path)).toBe(join(bin, "codex"));
    expect(which("claude", path)).toBeNull();
  });
});

describe("default route", () => {
  const reply = () => "ok";

  it("routes through the model manager in its order", () => {
    const models = mockModels([CLAUDE_CODE, CODEX, PI], reply);
    expect(selectExecutor(models)).toEqual(CLAUDE_CODE);
    expect(selectExecutor(mockModels([CODEX, PI], reply))).toEqual(CODEX);
    expect(selectExecutor(mockModels([PI], reply))).toEqual(PI);
  });

  it("says no provider is available when none can serve", () => {
    expect(() => selectExecutor(mockModels([], reply))).toThrow(NO_PROVIDER);
  });
});
