import { KeyValue } from "~/components/ui/key-value";
import { Text } from "~/components/ui/text";

export interface RunOverviewView {
  readonly cost: string;
  readonly currentStep: string;
  readonly elapsed: string;
  readonly error?: string;
  readonly id: string;
  readonly name: string;
  readonly observedSteps: number;
  readonly started: string;
  readonly status: string;
  readonly timing?: {
    readonly createdAt: number;
    readonly endedAt?: number;
    readonly startedAt?: number;
  };
  readonly tokens: string;
  readonly trigger: string;
}

export interface StepOverviewView {
  readonly children: number;
  readonly costHere: string;
  readonly costWithChildren: string;
  readonly elapsed: string;
  readonly error?: string;
  readonly id: string;
  readonly name: string;
  readonly runId: string;
  readonly status: string;
}

function at(ms: number | undefined, missing: string): string {
  return ms === undefined ? missing : new Date(ms).toLocaleString();
}

function timingFacts(run: RunOverviewView) {
  if (!run.timing) {
    return [{ key: "Started", value: run.started }];
  }
  return [
    { key: "Queued", value: at(run.timing.createdAt, "") },
    { key: "Started", value: at(run.timing.startedAt, "Not started") },
    { key: "Ended", value: at(run.timing.endedAt, "Not ended") },
  ];
}

export function RunOverview({ run }: { readonly run: RunOverviewView }) {
  return (
    <box flexDirection="column" gap={1}>
      <Text>
        <strong>{run.name}</strong>
      </Text>
      <KeyValue
        items={[
          { key: "Run", value: run.id },
          { key: "Status", value: run.status },
          { key: "Trigger", value: run.trigger },
          ...timingFacts(run),
          { key: "Elapsed", value: run.elapsed },
          { key: "Cost", value: run.cost },
          { key: "Tokens", value: run.tokens },
          { key: "Current step", value: run.currentStep },
          { key: "Observed steps", value: String(run.observedSteps) },
        ]}
      />
      {run.error && <Text>Error: {run.error}</Text>}
    </box>
  );
}

export function StepOverview({ step }: { readonly step: StepOverviewView }) {
  return (
    <box flexDirection="column" gap={1}>
      <Text>
        <strong>{step.name}</strong>
      </Text>
      <KeyValue
        items={[
          { key: "Run", value: step.runId },
          { key: "Step", value: step.id },
          { key: "Status", value: step.status },
          { key: "Elapsed", value: step.elapsed },
          { key: "Children", value: String(step.children) },
          { key: "Cost here", value: step.costHere },
          { key: "With children", value: step.costWithChildren },
        ]}
      />
      {step.error && <Text>Error: {step.error}</Text>}
    </box>
  );
}
