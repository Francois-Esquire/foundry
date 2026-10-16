import type { Skill } from "@foundry/core/agents";
import type { ToolSet } from "ai";

export type { Skill, SkillFile } from "@foundry/core/agents";

export interface SkillRegistry {
  add(...skills: Skill[]): SkillRegistry;
  get(name: string): Skill | undefined;
  readonly instructions: string;
  list(): Skill[];
  remove(name: string): SkillRegistry;
  readonly tools: ToolSet;
}
