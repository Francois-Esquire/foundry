import type { StartupCounts } from "~/model/splash";
import type { DashboardSnapshot } from "./dashboard-model";

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
