import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, codex, pi } from "@foundry/prompts";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../settings";

const names = (
  value: Iterable<string> | ((name: string) => boolean) | undefined
) =>
  value === undefined || typeof value === "function"
    ? value
    : [...value].sort();

describe("resolveSettings", () => {
  it("defaults to the stock dialects, no sources, and the message surface", () => {
    expect(resolveSettings({}, "/")).toEqual({
      dialects: { claude: claudeCode, codex, pi },
      sources: undefined,
      surface: "message",
    });
  });

  it("maps extra member names to stock dialects", () => {
    const resolved = resolveSettings(
      { foundryPrompts: { dialects: { house: "claude", other: "pi" } } },
      "/"
    );
    expect(resolved.dialects.house).toBe(claudeCode);
    expect(resolved.dialects.other).toBe(pi);
    expect(resolved.dialects.codex).toBe(codex);
  });

  it("takes names as written and lists directories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "foundry-prompts-"));
    mkdirSync(join(cwd, ".claude/skills/review"), { recursive: true });
    mkdirSync(join(cwd, ".claude/skills/.hidden"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/notes.txt"), "");
    mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
    writeFileSync(join(cwd, ".claude/agents/reviewer.md"), "");
    writeFileSync(join(cwd, ".claude/agents/.draft.md"), "");
    writeFileSync(join(cwd, ".claude/agents/README.txt"), "");
    const resolved = resolveSettings(
      {
        foundryPrompts: {
          agents: [".claude/agents", "planner"],
          skills: ["plugin:lint", ".claude/skills", join(cwd, "missing/")],
        },
      },
      cwd
    );
    expect(names(resolved.sources?.skill)).toEqual(["plugin:lint", "review"]);
    expect(names(resolved.sources?.agent)).toEqual(["planner", "reviewer"]);
  });

  it("covers a kind as soon as it is listed, even empty", () => {
    expect(
      resolveSettings({ foundryPrompts: { skills: [] } }, "/").sources
    ).toEqual({
      skill: [],
    });
    expect(
      resolveSettings({ foundryPrompts: { agents: [] } }, "/").sources
    ).toEqual({
      agent: [],
    });
  });

  it("reads the surface", () => {
    expect(
      resolveSettings({ foundryPrompts: { surface: "template" } }, "/").surface
    ).toBe("template");
  });

  it("rejects malformed settings with a clear message", () => {
    expect(() => resolveSettings({ foundryPrompts: 1 }, "/")).toThrow(
      "settings.foundryPrompts: must be an object."
    );
    expect(() =>
      resolveSettings({ foundryPrompts: { surface: "file" } }, "/")
    ).toThrow('"surface" must be "message" or "template".');
    expect(() =>
      resolveSettings({ foundryPrompts: { skills: "review" } }, "/")
    ).toThrow('"skills" must be a list of strings.');
    expect(() =>
      resolveSettings({ foundryPrompts: { agents: [1] } }, "/")
    ).toThrow('"agents" must be a list of strings.');
    expect(() =>
      resolveSettings({ foundryPrompts: { dialects: ["claude"] } }, "/")
    ).toThrow('"dialects" must map member names');
    expect(() =>
      resolveSettings(
        { foundryPrompts: { dialects: { house: "cursor" } } },
        "/"
      )
    ).toThrow(
      '"dialects.house" must be "claude", "codex", or "pi", not "cursor".'
    );
  });
});
