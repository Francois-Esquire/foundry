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

import { which } from "~/harnesses";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true });
  }
});

describe("which", () => {
  it("returns the first executable on PATH, skipping non-executables", () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-path-"));
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
