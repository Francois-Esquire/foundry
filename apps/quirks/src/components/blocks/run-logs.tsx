import { Log } from "~/components/ui/log";
import {
  flattenSteps,
  type RunSnapshot,
  type StepSnapshot,
} from "~/views/dashboard-model";

export function RunLogs({
  run,
  step,
  focused,
}: {
  readonly run: RunSnapshot;
  readonly step?: StepSnapshot;
  readonly focused: boolean;
}) {
  const ids = step
    ? new Set([
        step.id,
        ...flattenSteps(step.children).map((entry) => entry.step.id),
      ])
    : undefined;
  const logs = (run.logs ?? []).filter(
    (entry) => !ids || (entry.stepId !== undefined && ids.has(entry.stepId))
  );
  return <Log entries={logs} focused={focused} />;
}
