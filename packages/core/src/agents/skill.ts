/**
 * Named capability an agent loads on demand: instructions + bundled files.
 * Source-agnostic (code, JSON, filesystem).
 */
export interface Skill {
  description: string;
  files?: Record<string, SkillFile>;
  instructions?: string;
  name: string;
}

export type SkillFile = string | Uint8Array;
