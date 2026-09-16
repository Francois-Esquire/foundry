import type { ToolSet } from "ai";

/**
 * Named capability an agent loads on demand: instructions + bundled files.
 * Discovered via list_skills/load_skill; one file at a time, never entire bundle.
 * Source-agnostic (code, JSON, filesystem).
 */
export interface Skill {
  description: string;
  files?: Record<string, SkillFile>;
  instructions?: string;
  name: string;
}

export type SkillFile = string | Uint8Array;

export interface SkillRegistry {
  add(...skills: Skill[]): SkillRegistry;
  get(name: string): Skill | undefined;
  readonly instructions: string;
  list(): Skill[];
  remove(name: string): SkillRegistry;
  readonly tools: ToolSet;
}
