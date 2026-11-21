interface Skill {
  readonly description: string;
  readonly name: string;
}

interface Server {
  readonly description: string;
  readonly name: string;
  readonly tools: readonly {
    readonly description: string;
    readonly name: string;
  }[];
}

export const EFFORTS = ["low", "medium", "high"] as const;

export type Effort = (typeof EFFORTS)[number];

export interface Weapon {
  readonly effort: Effort;
  readonly model: string;
}

export interface Context {
  readonly limit: number;
  readonly models: readonly [string, ...string[]];
  readonly provider: string;
  readonly servers: readonly Server[];
  readonly skills: readonly Skill[];
}

export interface Slot {
  readonly description: string;
  readonly kind: "mcp" | "skill";
  readonly name: string;
}

export function slotsOf(context: Context): Slot[] {
  return [
    ...context.skills.map((skill) => ({ ...skill, kind: "skill" as const })),
    ...context.servers.map(({ description, name }) => ({
      description,
      kind: "mcp" as const,
      name,
    })),
  ];
}
