export interface Skill {
  description: string;
  files?: Record<string, SkillFile>;
  instructions?: string;
  name: string;
}

export type SkillFile = string | Uint8Array;
