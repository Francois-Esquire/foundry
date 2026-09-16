import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatherAgents, parseAgentSpec } from "../../agents/gather-agents";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agents-gather-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("parseAgentSpec", () => {
  const source = { kind: "file", path: "/r/a.md", root: "/r" } as const;

  it("parses id, model, prompt, and the tools/mcp comma lists", () => {
    const spec = parseAgentSpec(
      [
        "---",
        "name: researcher",
        "model: openai/gpt-4o-mini",
        "tools: read, grep",
        "mcp: github, context7",
        "---",
        "",
        "Research things thoroughly.",
      ].join("\n"),
      "fallback",
      source
    );
    expect(spec).toEqual({
      id: "researcher",
      mcp: ["github", "context7"],
      model: "openai/gpt-4o-mini",
      prompt: "Research things thoroughly.",
      source,
      tools: ["read", "grep"],
    });
  });

  it("parses skills and role when present", () => {
    const spec = parseAgentSpec(
      [
        "---",
        "name: r",
        "role: Aide",
        "skills: architect, audit",
        "---",
        "",
        "Body.",
      ].join("\n"),
      "r",
      source
    );
    expect(spec).toMatchObject({
      role: "Aide",
      skills: ["architect", "audit"],
    });
  });

  it("falls back to the file id and omits model when absent", () => {
    const spec = parseAgentSpec("---\n---\n\nDo things.", "myfile", source);
    expect(spec).toMatchObject({ id: "myfile", mcp: [], tools: [] });
    expect(spec && "model" in spec).toBe(false);
  });

  it("returns null for an empty body", () => {
    expect(parseAgentSpec("---\nname: x\n---\n", "x", source)).toBeNull();
  });
});

describe("gatherAgents", () => {
  it("discovers and returns one spec per *.md file", async () => {
    await writeFile(
      join(root, "researcher.md"),
      [
        "---",
        "name: researcher",
        "model: openai/gpt-4o-mini",
        "tools: read, grep",
        "---",
        "",
        "Research things thoroughly.",
      ].join("\n")
    );

    const specs = await gatherAgents([root]);

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: "researcher",
      source: { kind: "file", root },
      tools: ["read", "grep"],
    });
  });

  it("skips a malformed definition while a good one is returned", async () => {
    await writeFile(
      join(root, "empty.md"),
      ["---", "name: empty", "---", ""].join("\n")
    );
    await writeFile(
      join(root, "valid.md"),
      ["---", "name: valid", "---", "", "Do valid things."].join("\n")
    );

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const specs = await gatherAgents([root]);

    expect(specs.map((s) => s.id)).toEqual(["valid"]);
  });

  it("dedupes by id across roots — the first root wins", async () => {
    await writeFile(
      join(root, "dup.md"),
      ["---", "name: dup", "model: from-root-a", "---", "", "A body."].join(
        "\n"
      )
    );
    const rootB = await mkdtemp(join(tmpdir(), "agents-gather-b-"));
    try {
      await writeFile(
        join(rootB, "dup.md"),
        ["---", "name: dup", "model: from-root-b", "---", "", "B body."].join(
          "\n"
        )
      );

      const specs = await gatherAgents([root, rootB]);

      expect(specs).toHaveLength(1);
      expect(specs[0]?.model).toBe("from-root-a");
    } finally {
      await rm(rootB, { force: true, recursive: true });
    }
  });

  it("returns nothing for a non-existent root", async () => {
    expect(await gatherAgents([join(root, "nope")])).toEqual([]);
  });
});
