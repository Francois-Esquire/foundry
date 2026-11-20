import type { ChannelMessage } from "@foundry/workflows/channels";
import type { InputValues } from "~/lib/inputs";

export type Launcher = (
  name: string,
  input: InputValues | undefined
) => Promise<string>;

export interface RunActions {
  cancel(runId: string): Promise<void>;
  deleteTrigger?(id: string): Promise<void>;
  pause(runId: string, stepId: string): Promise<void>;
  resume(runId: string, stepId: string, prompt?: string): Promise<void>;
  setTriggerEnabled?(id: string, enabled: boolean): Promise<void>;
  steer(runId: string, stepId: string, prompt: string): Promise<void>;
  stopActivity?(sessionId: string, id: string): Promise<void>;
  stream?(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined;
}

export interface RunPrompt {
  readonly kind: "steer" | "resume";
  readonly runId: string;
  readonly stepId: string;
}
