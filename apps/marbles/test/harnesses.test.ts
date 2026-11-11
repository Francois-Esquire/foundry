import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { ModelKind, Provider } from "@foundry/models";
import { ModelManager } from "@foundry/models";
import { airplaneMode } from "@foundry/models/airplane";
import { CLAUDE_CODE_DEFAULT_MODELS } from "@foundry/models/claude-code";
import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_CODE, CODEX, PI, selectExecutor, which } from "~/lib/harnesses";
import { mockModels } from "~/lib/models/echo";

const NO_PROVIDER = /No configured model provider is available/;
const REFUSED = /refused by airplane/;

function serving(
  id: string,
  options: {
    readonly defaults?: Partial<Record<ModelKind, string>>;
    readonly offline?: boolean;
  } = {}
): Provider {
  return {
    available: true,
    ...(options.defaults ? { defaults: options.defaults } : {}),
    id,
    languageModel: () => ({}) as never,
    models:
      id === "claude-code"
        ? CLAUDE_CODE_DEFAULT_MODELS
        : [{ id: "m", kind: "text", modelId: "m" }],
    offline: options.offline ?? false,
  };
}

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

  it("keeps a provider's configured text default over its harness's own", () => {
    const configured = new ModelManager({
      providers: [serving("claude-code", { defaults: { text: "haiku" } })],
    });
    expect(selectExecutor(configured).model).toBe("haiku");
    const plain = new ModelManager({ providers: [serving("claude-code")] });
    expect(selectExecutor(plain).model).toBe(CLAUDE_CODE.model);
  });

  it("lets the manager skip a provider its policy refuses", () => {
    const models = new ModelManager({
      providers: [serving("claude-code"), serving("local", { offline: true })],
    });
    airplaneMode(models).set(true);
    expect(selectExecutor(models)).toEqual({
      harness: "direct",
      model: "m",
      provider: "local",
    });
  });

  it("reports the refusal when the policy refuses every provider", () => {
    const models = new ModelManager({ providers: [serving("claude-code")] });
    airplaneMode(models).set(true);
    expect(() => selectExecutor(models)).toThrow(REFUSED);
  });
});
