import { describe, expect, it } from "vitest";
import { createSkillRegistry } from "../../skills/registry";
import type { Skill } from "../../skills/types";

// The two meta-tools ignore the call options, so a minimal stub satisfies the
// `tool()` execute signature when invoking them directly in a test.
const opts = { context: undefined, messages: [], toolCallId: "test" };

function skill(name: string, partial: Partial<Skill> = {}): Skill {
  return { description: `${name} skill`, name, ...partial };
}

describe("createSkillRegistry", () => {
  it("exposes exactly the list_skills and load_skill meta-tools", () => {
    const registry = createSkillRegistry([skill("a")]);
    expect(Object.keys(registry.tools).sort()).toEqual([
      "list_skills",
      "load_skill",
    ]);
  });

  it("list_skills returns the catalog of available skills", async () => {
    const registry = createSkillRegistry([
      skill("audit", { description: "judge code" }),
      skill("planner", { description: "plan work" }),
    ]);

    const result: unknown = await registry.tools.list_skills?.execute?.(
      {},
      opts
    );
    expect(result).toEqual([
      { description: "judge code", name: "audit" },
      { description: "plan work", name: "planner" },
    ]);
  });

  it("load_skill treats an empty file name as no file", async () => {
    const registry = createSkillRegistry([
      skill("audit", {
        files: { "refs/guide.md": "the full guide body" },
        instructions: "Apply expert judgment.",
      }),
    ]);

    const result: unknown = await registry.tools.load_skill?.execute?.(
      { file: "", name: "audit" },
      opts
    );

    expect(result).toContain("Apply expert judgment.");
    expect(result).not.toContain("has no file");
  });

  it("load_skill returns a skill's instructions and an index of file names", async () => {
    const registry = createSkillRegistry([
      skill("audit", {
        description: "judge code",
        files: {
          "data.json": "{}",
          "refs/guide.md": "the full guide body",
        },
        instructions: "Apply expert judgment.",
      }),
    ]);

    const result: unknown = await registry.tools.load_skill?.execute?.(
      { name: "audit" },
      opts
    );
    expect(result).toContain("# Skill: audit");
    expect(result).toContain("Apply expert judgment.");
    // The index lists file names, not their contents — content stays out of context.
    expect(result).toContain("- refs/guide.md");
    expect(result).toContain("- data.json");
    expect(result).not.toContain("the full guide body");
  });

  it("load_skill with a file returns that file's contents", async () => {
    const registry = createSkillRegistry([
      skill("audit", {
        files: {
          "logo.png": new TextEncoder().encode("decoded bytes"),
          "refs/guide.md": "the full guide body",
        },
      }),
    ]);

    const text: unknown = await registry.tools.load_skill?.execute?.(
      { file: "refs/guide.md", name: "audit" },
      opts
    );
    expect(text).toContain("# File: refs/guide.md");
    expect(text).toContain("the full guide body");

    // Uint8Array content is decoded to UTF-8 text.
    const bytes: unknown = await registry.tools.load_skill?.execute?.(
      { file: "logo.png", name: "audit" },
      opts
    );
    expect(bytes).toContain("decoded bytes");
  });

  it("load_skill reports an unknown file with the skill's file list", async () => {
    const registry = createSkillRegistry([
      skill("audit", { files: { "refs/guide.md": "body" } }),
    ]);

    const result: unknown = await registry.tools.load_skill?.execute?.(
      { file: "nope.md", name: "audit" },
      opts
    );
    expect(result).toContain('has no file "nope.md"');
    expect(result).toContain("refs/guide.md");
  });

  it("load_skill reports unknown names with the available list", async () => {
    const registry = createSkillRegistry([skill("audit"), skill("planner")]);

    const result: unknown = await registry.tools.load_skill?.execute?.(
      { name: "nope" },
      opts
    );
    expect(result).toContain('No skill named "nope"');
    expect(result).toContain("audit");
    expect(result).toContain("planner");
  });

  it("projects instructions as a preamble plus the name/description catalog", () => {
    expect(createSkillRegistry().instructions).toBe("");

    const registry = createSkillRegistry([
      skill("audit", { description: "judge code" }),
    ]);
    expect(registry.instructions).toContain("## Skills");
    expect(registry.instructions).toContain("- audit: judge code");
  });

  it("loads, unloads, and lists in registration order", () => {
    const registry = createSkillRegistry();
    registry.add(skill("first")).add(skill("second"), skill("third"));
    expect(registry.list().map((s) => s.name)).toEqual([
      "first",
      "second",
      "third",
    ]);

    registry.remove("second");
    expect(registry.list().map((s) => s.name)).toEqual(["first", "third"]);
    expect(registry.get("third")?.name).toBe("third");
    expect(registry.get("second")).toBeUndefined();
  });

  it("re-adding a name replaces the available skill", () => {
    const registry = createSkillRegistry([skill("x", { description: "old" })]);
    registry.add(skill("x", { description: "new" }));

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("x")?.description).toBe("new");
    expect(registry.instructions).toContain("- x: new");
  });

  it("memoizes instructions until the set changes; tools stay stable", () => {
    const registry = createSkillRegistry([skill("a", { description: "d" })]);

    const instructions = registry.instructions;
    const tools = registry.tools;
    expect(registry.instructions).toBe(instructions);
    expect(registry.tools).toBe(tools);

    registry.add(skill("b", { description: "e" }));
    expect(registry.instructions).not.toBe(instructions);
    expect(registry.instructions).toContain("- b: e");
    // The tool surface is fixed; only its backing skill set changed.
    expect(registry.tools).toBe(tools);
  });
});
