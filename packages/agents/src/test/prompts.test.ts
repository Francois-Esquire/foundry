import { assemble, claudeCode, codex } from "@foundry/prompts";
import { describe, expect, it } from "vitest";

import { createAgentRegistry } from "../agents/registry";
import type { AgentPreset } from "../agents/resolve";
import { createCatalog } from "../prompts";
import { defineSkill } from "../skills/define";
import { createSkillRegistry } from "../skills/registry";

const preset = {} as AgentPreset;

describe("createCatalog", () => {
  it("answers for skills and agents from the live registries", () => {
    const skills = createSkillRegistry([{ description: "", name: "review" }]);
    const agents = createAgentRegistry();
    agents.registerPreset({ generation: 0, id: "reviewer", preset });
    const source = createCatalog({ agents, skills });

    expect(source.covers("skill")).toBe(true);
    expect(source.covers("agent")).toBe(true);
    expect(source.covers("file")).toBe(false);
    expect(source.has("skill", "review")).toBe(true);
    expect(source.has("agent", "reviewer")).toBe(true);
    expect(source.has("skill", "nope")).toBe(false);

    skills.add({ description: "", name: "later" });
    expect(source.has("skill", "later")).toBe(true);
  });

  it("leaves a kind uncovered when its registry is absent", () => {
    const source = createCatalog({ skills: createSkillRegistry() });
    expect(source.covers("agent")).toBe(false);
    expect(source.has("agent", "anyone")).toBe(false);
  });

  it("layers into a prompts that checks what it authors", () => {
    const skills = createSkillRegistry([{ description: "", name: "review" }]);
    const prompts = assemble({
      dialects: { claude: claudeCode },
      sources: [createCatalog({ skills }), { file: ["src/a.ts"] }],
    });
    expect(prompts.claude`/review @src/a.ts`.ok).toBe(true);
    const checked = prompts.claude`/nope @src/b.ts`;
    expect(checked.diagnostics.map((item) => item.message)).toEqual([
      'Unknown skill "nope".',
      'Unknown file "src/b.ts".',
    ]);
  });
});

describe("skills by value", () => {
  it("lets a defined skill stand in a prompt and stay plain data", () => {
    const skill = defineSkill({
      manifest:
        "---\nname: review\ndescription: Review code\n---\nLook closely.",
    });
    const prompts = assemble({
      dialects: { claude: claudeCode, codex },
      sources: [createCatalog({ skills: createSkillRegistry([skill]) })],
    });
    const claude = prompts.claude`Use ${skill} here`;
    expect(claude.text).toBe("Use /review here");
    expect(prompts.codex`Use ${skill}`.text).toBe("Use $review");
    expect(claude.references[0]).toMatchObject({
      kind: "skill",
      name: "review",
      origin: "symbol",
    });
    expect(claude.ok).toBe(true);
    expect(Object.keys(skill)).toEqual(["description", "name", "instructions"]);
    expect(JSON.parse(JSON.stringify(skill))).toEqual({
      description: "Review code",
      instructions: "Look closely.",
      name: "review",
    });
  });
});
