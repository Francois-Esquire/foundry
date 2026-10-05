import { KeyValue } from "~/components/ui/key-value";
import { Text } from "~/components/ui/text";
import {
  flattenSteps,
  type RunSnapshot,
  runStatusLabel,
  type StepSnapshot,
} from "~/views/dashboard-model";

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
          { key: "Status", value: runStatusLabel(run) },
          { key: "Trigger", value: trigger },
          { key: "Started", value: run.started },
          { key: "Elapsed", value: run.elapsed },
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
          { key: "Status", value: runStatusLabel(step) },
          { key: "Elapsed", value: step.elapsed ?? "Not recorded" },
          { key: "Children", value: String(step.children.length) },
        ]}
      />
      {step.error && <Text>Error: {step.error}</Text>}
    </box>
  );
}
