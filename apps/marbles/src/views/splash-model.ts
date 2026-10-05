import type { DashboardSnapshot } from "./dashboard-model";

export interface StartupCounts {
  readonly monitors: number;
  readonly runs: number;
  readonly schedules: number;
  readonly steps: number;
  readonly workflows: number;
}

export type SplashState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly hasConfig?: boolean;
      readonly counts: StartupCounts;
    };

export function summarizeConfig(snapshot: DashboardSnapshot): StartupCounts {
  return {
    monitors: snapshot.triggers.filter((item) => item.kind === "monitor")
      .length,
    runs: snapshot.runs.length,
    schedules: snapshot.triggers.filter((item) => item.kind === "schedule")
      .length,
    steps: snapshot.definitions.filter((item) => item.kind === "step").length,
    workflows: snapshot.definitions.filter((item) => item.kind === "workflow")
      .length,
  };
}
