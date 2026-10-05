import type { ChannelMessage } from "@foundry/workflows/channels";

/**
 * What a host lets the dashboard do to a live run. None of it is authored
 * code: the run scope wires cancellation, pausing, and steering for every
 * step, so the dashboard only needs the run and step ids it already shows.
 */
export interface RunActions {
  cancel(runId: string): Promise<void>;
  deleteTrigger?(id: string): Promise<void>;
  /** Park a running step; rejects when it is not running here. */
  pause(runId: string, stepId: string): Promise<void>;
  /** Resume a paused step, with a prompt for its agent or without one. */
  resume(runId: string, stepId: string, prompt?: string): Promise<void>;
  setTriggerEnabled?(id: string, enabled: boolean): Promise<void>;
  /** Hand a prompt to the agent turn running in a step. */
  steer(runId: string, stepId: string, prompt: string): Promise<void>;
  stopActivity?(sessionId: string, id: string): Promise<void>;
  /** A live run's events and chunks; `undefined` once it is not held here. */
  stream?(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined;
}

/** The dashboard is taking a line of text for one of these. */
export interface RunPrompt {
  readonly kind: "steer" | "resume";
  readonly runId: string;
  readonly stepId: string;
}
