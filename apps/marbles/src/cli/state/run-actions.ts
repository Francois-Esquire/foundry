import type { ChannelMessage } from "@foundry/workflows/channels";
import type { InputValues } from "~/lib/inputs";
import type { LiveWork, StepInput } from "~/lib/step-work";

export type Launcher = (
  name: string,
  input: InputValues | undefined
) => Promise<string>;

export interface RunActions {
  cancel(runId: string): Promise<void>;
  deleteTrigger?(id: string): Promise<void>;
  pause(runId: string, stepId: string): Promise<void>;
  resume(runId: string, stepId: string, prompt?: string): Promise<void>;
  send(runId: string, stepId: string, input: StepInput): Promise<void>;
  setTriggerEnabled?(id: string, enabled: boolean): Promise<void>;
  stopActivity?(sessionId: string, id: string): Promise<void>;
  stream?(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined;
}

export type RunPrompt =
  | {
      readonly kind: "resume";
      readonly runId: string;
      readonly stepId: string;
    }
  | {
      readonly chosen: number;
      readonly kind: "send";
      readonly runId: string;
      readonly targets: readonly LiveWork[];
    };

const COMMAND_WIDTH = 40;
const IDENTIFIER_WIDTH = 6;
const SESSION_WIDTH = 8;

function describeWork(work: LiveWork): string {
  if (work.kind === "agent") {
    const route = [work.provider, work.model].filter(Boolean).join("/");
    const name = ["agent", work.agent, route].filter(Boolean).join(" ");
    return `${name} · session ${work.sessionId.slice(0, SESSION_WIDTH)}`;
  }
  const command =
    work.command.length > COMMAND_WIDTH
      ? `$ ${work.command.slice(0, COMMAND_WIDTH - 1)}…`
      : `$ ${work.command}`;
  return work.pid === undefined
    ? command
    : `${command} · pid ${String(work.pid)}`;
}

export function workLabel(work: LiveWork): string {
  return `#${work.id.slice(0, IDENTIFIER_WIDTH)} ${describeWork(work)}`;
}

export function inputVerb(work: LiveWork | undefined): "input" | "steer" {
  return work?.input === "stdin" ? "input" : "steer";
}

function promptLabel(prompt: RunPrompt): string {
  if (prompt.kind === "resume") {
    return `resume ${prompt.stepId} · prompt optional › `;
  }
  const target = promptTarget(prompt);
  if (!target) {
    return "nothing live › ";
  }
  return `${inputVerb(target)} ${target.stepId} · ${workLabel(target)} › `;
}

export function promptTarget(
  prompt: Extract<RunPrompt, { kind: "send" }>
): LiveWork | undefined {
  return prompt.targets[prompt.chosen];
}

export function promptLabels(prompt: RunPrompt): readonly string[] {
  if (prompt.kind === "resume") {
    return [promptLabel(prompt), `resume ${prompt.stepId} ›`];
  }
  const target = promptTarget(prompt);
  return target
    ? [
        promptLabel(prompt),
        `${inputVerb(target)} ${target.stepId} · #${target.id.slice(0, IDENTIFIER_WIDTH)} ›`,
      ]
    : [promptLabel(prompt)];
}
