export interface SharedConfig {
  retries: number;
}

export type SharedMode = "on" | "off";

export function sharedInit(config: SharedConfig): number {
  return config.retries;
}

export function sharedRun(): number {
  return 1;
}

export const SHARED_LIMIT = 10;
