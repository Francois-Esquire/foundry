import { KeyValue } from "~/components/ui/key-value";
import { Text } from "~/components/ui/text";
import { statusDisplay } from "~/model/run-status";
import {
  flattenSteps,
  type RunSnapshot,
  type StepSnapshot,
} from "~/views/dashboard-model";
import { costLabel, tokensLabel } from "~/views/usage-format";

function at(ms: number | undefined, missing: string): string {
  return ms === undefined ? missing : new Date(ms).toLocaleString();
}

export function RunOverview({
  run,
  trigger,
}: {
  readonly run: RunSnapshot;
  readonly trigger: string;
}) {
  const active = flattenSteps(run.steps).filter(
    ({ step }) => step.status === "running"
  );
  return (
    <box flexDirection="column" gap={1}>
      <Text>
        <strong>{run.name}</strong>
      </Text>
      <KeyValue
        items={[
          { key: "Run", value: run.id },
          { key: "Status", value: statusDisplay(run).label },
          { key: "Trigger", value: trigger },
          ...(run.timing
            ? [
                { key: "Queued", value: at(run.timing.createdAt, "") },
                {
                  key: "Started",
                  value: at(run.timing.startedAt, "Not started"),
                },
                {
                  key: "Ended",
                  value: at(run.timing.endedAt, "Not ended"),
                },
              ]
            : [{ key: "Started", value: run.started }]),
          { key: "Elapsed", value: run.elapsed },
          { key: "Cost", value: costLabel(run.usage) },
          { key: "Tokens", value: tokensLabel(run.usage) },
          { key: "Current step", value: active.at(-1)?.step.name ?? "None" },
          {
            key: "Observed steps",
            value: String(flattenSteps(run.steps).length),
          },
        ]}
      />
      {run.error && <Text>Error: {run.error}</Text>}
    </box>
  );
}

export function StepOverview({
  run,
  step,
}: {
  readonly run: RunSnapshot;
  readonly step: StepSnapshot;
}) {
  return (
    <box flexDirection="column" gap={1}>
      <Text>
        <strong>{step.name}</strong>
      </Text>
      <KeyValue
        items={[
          { key: "Run", value: run.id },
          { key: "Step", value: step.id },
          { key: "Status", value: statusDisplay(step).label },
          { key: "Elapsed", value: step.elapsed ?? "Not recorded" },
          { key: "Children", value: String(step.children.length) },
          { key: "Cost here", value: costLabel(step.usage?.direct) },
          {
            key: "With children",
            value: costLabel(step.usage?.inclusive),
          },
        ]}
      />
      {step.error && <Text>Error: {step.error}</Text>}
    </box>
  );
}
