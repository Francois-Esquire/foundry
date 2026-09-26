// Contract implemented in two packages that never import each other.
export interface Plugin {
  run(): number;
  stop(): void;
}
