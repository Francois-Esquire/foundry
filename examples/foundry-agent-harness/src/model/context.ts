export interface Skill {
  readonly description: string;
  readonly name: string;
}

export interface Server {
  readonly description: string;
  readonly name: string;
  readonly tools: readonly {
    readonly description: string;
    readonly name: string;
  }[];
}

export interface Context {
  readonly model: string;
  readonly servers: readonly Server[];
  readonly skills: readonly Skill[];
}
