import type { ErrorShape } from "./types";

export type RunLifecycleEvent =
  | {
      kind: "dispatched";
      runId: string;
      step: string;
      tags: Record<string, string>;
    }
  | { kind: "started"; runId: string }
  | { kind: "suspended"; runId: string; at: string }
  | { kind: "resumed"; runId: string; at: string }
  | { kind: "completed"; runId: string; output: unknown }
  | { kind: "failed"; runId: string; error: ErrorShape }
  | { kind: "cancelled"; runId: string }
  | { kind: "recovered"; runId: string };

export interface OrchestratorLogger {
  on(event: RunLifecycleEvent): void;
}

export class BaseOrchestratorLogger implements OrchestratorLogger {
  on(event: RunLifecycleEvent): void {
    switch (event.kind) {
      case "dispatched":
        this.dispatched(event);
        break;
      case "started":
        this.started(event);
        break;
      case "suspended":
        this.suspended(event);
        break;
      case "resumed":
        this.resumed(event);
        break;
      case "completed":
        this.completed(event);
        break;
      case "failed":
        this.failed(event);
        break;
      case "cancelled":
        this.cancelled(event);
        break;
      case "recovered":
        this.recovered(event);
        break;
      default:
        break;
    }
  }

  // biome-ignore-start lint/complexity/noUselessReturn: Default lifecycle hooks do no work.
  protected dispatched(
    _event: Extract<RunLifecycleEvent, { kind: "dispatched" }>
  ): void {
    return;
  }

  protected started(
    _event: Extract<RunLifecycleEvent, { kind: "started" }>
  ): void {
    return;
  }

  protected suspended(
    _event: Extract<RunLifecycleEvent, { kind: "suspended" }>
  ): void {
    return;
  }

  protected resumed(
    _event: Extract<RunLifecycleEvent, { kind: "resumed" }>
  ): void {
    return;
  }

  protected completed(
    _event: Extract<RunLifecycleEvent, { kind: "completed" }>
  ): void {
    return;
  }

  protected failed(
    _event: Extract<RunLifecycleEvent, { kind: "failed" }>
  ): void {
    return;
  }

  protected cancelled(
    _event: Extract<RunLifecycleEvent, { kind: "cancelled" }>
  ): void {
    return;
  }

  protected recovered(
    _event: Extract<RunLifecycleEvent, { kind: "recovered" }>
  ): void {
    return;
  }
  // biome-ignore-end lint/complexity/noUselessReturn: End of the default lifecycle hooks.
}
