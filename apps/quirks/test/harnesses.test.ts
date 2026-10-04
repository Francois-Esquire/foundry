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

import {
  allowedExecutors,
  CLAUDE_CODE,
  CODEX,
  harnessModels,
  selectExecutor,
  selectedHarnesses,
  which,
} from "~/lib/harnesses";

const UNAVAILABLE_CODEX = /codex harness is not available on this machine/;
const NO_HARNESS = /No harness is available/;
const UNKNOWN_HARNESS = /pi harness is not available\./;

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

describe("harness selection", () => {
  const both = { claudeCode: true, codex: "/usr/local/bin/codex" };

  it("routes through the model manager, not the PATH list", () => {
    const models = harnessModels(both);
    expect(selectExecutor(models)).toEqual(CLAUDE_CODE);
    expect(selectExecutor(models, "codex")).toEqual(CODEX);
  });

  it("names the harness that cannot run", () => {
    const models = harnessModels({ claudeCode: true, codex: null });
    expect(() => selectExecutor(models, "codex")).toThrow(UNAVAILABLE_CODEX);
    expect(() => selectExecutor(models, "pi")).toThrow(UNKNOWN_HARNESS);
    expect(() =>
      selectExecutor(harnessModels({ claudeCode: false, codex: null }))
    ).toThrow(NO_HARNESS);
  });

  it("narrows detection to --harness and echoes every allowed harness under --dry", () => {
    expect(selectedHarnesses(both, ["codex"])).toEqual({
      claudeCode: false,
      codex: "/usr/local/bin/codex",
    });
    expect(selectedHarnesses(both, [])).toBe(both);
    expect(allowedExecutors([])).toEqual([CLAUDE_CODE, CODEX]);
    expect(allowedExecutors(["codex"])).toEqual([CODEX]);
  });
});
