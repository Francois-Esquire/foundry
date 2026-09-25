import type { DefinitionOptions } from "./inputs";

export type { DefinitionOptions, InputField } from "./inputs";

import type { AgentSpec } from "@foundry/agents/agents/index";
import type { DefinitionSource } from "@foundry/workflows/definitions";
import type { Step } from "@foundry/workflows/step";
import type { Workflow } from "@foundry/workflows/workflow";

import type { CalendarSlot, StepBody, WorkflowBody } from "~/lib/registry";
import { registry } from "~/lib/registry";
import type { MonitorHandler, MonitorOptions } from "~/monitor";
import { DEFAULT_EVERY, detector, resolveMonitor } from "~/monitor";
import { parseAt } from "~/schedule";

/**
 * The configuration module imports these registration factories.
 *
 * Each factory registers by name as a side effect and returns the definition
 * it registered, so config code passes handles and only the CLI and schedules
 * address anything by string. Step bodies receive `ModelManager`,
 * `SessionHarness`, and the `Workspaces` interface through their primitives.
 */

export function step<I, O>(
  name: string,
  body: StepBody<I, O>,
  options?: DefinitionOptions
): Step<I, O> {
  return registry.step(name, body, options);
}

export function workflow<I, O>(
  name: string,
  body: WorkflowBody<I, O>,
  options?: DefinitionOptions
): Workflow<I, O> {
  return registry.workflow(name, body, options);
}

/**
 * A retained agent: prompt, model, and the skills it mounts by name. A step
 * opens it as a session through `agents.session(handle, { sessionId })`.
 */
export function agent(name: string, spec: Omit<AgentSpec, "id">): AgentSpec {
  return registry.agent({ ...spec, id: name });
}

/** A registered step or workflow: what `step()` and `workflow()` return. */
export type Handle<I> = DefinitionSource<I> & { readonly name: string };

export interface ScheduleOptions<I> {
  /** An interval (`"30m" | "6h" | "1d"`) or a calendar slot (`{ weekday: "mon", hour: 9 }`). */
  readonly at: string | CalendarSlot;
  readonly input: I;
  readonly workflow: Handle<I> | string;
}

export function schedule<I>(name: string, options: ScheduleOptions<I>): void {
  const target = options.workflow;
  registry.schedule({
    input: options.input,
    name,
    trigger: parseAt(options.at),
    workflow: typeof target === "string" ? target : target.name,
  });
}

/**
 * A schedule whose step is a change detector wrapping `handler`. A string is
 * a glob over the config's directory, an `http(s)://` URL polled every
 * minute, or a `ws(s)://` URL that is live under `run` only; the object
 * forms set root, cadence, request and `select`.
 */
export function monitor(
  name: string,
  handler: MonitorHandler,
  options: MonitorOptions
): void {
  const spec = resolveMonitor(options);
  registry.monitor(
    name,
    spec,
    detector(name, spec, handler),
    parseAt((spec.kind === "ws" ? undefined : spec.every) ?? DEFAULT_EVERY)
  );
}

export type { AgentSpec } from "@foundry/agents/agents/index";
export type { SessionHarnessSettings } from "@foundry/agents/harness";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for configuration imports.
export { SessionHarness } from "@foundry/agents/harness";
export type { SessionMessage, SessionStore } from "@foundry/agents/session";
export type { TurnExecutorRef } from "@foundry/models";
export { ModelManager } from "@foundry/models";
export { WorkspaceSystem } from "@foundry/workspaces";
export type { GitRun, GitSnapshot } from "@foundry/workspaces/git";
export { Git, Worktree } from "@foundry/workspaces/git";
export type { Feed, FeedKind, FeedPost, FeedQuestion } from "~/feed/entry";
export type { Log, LogLevel } from "~/lib/log";
export type {
  CalendarSlot,
  Primitives,
  SessionOptions,
  StepStream,
  Weekday,
  Workspaces,
} from "~/lib/registry";
export type {
  Change,
  FileChange,
  FileMonitor,
  HttpChange,
  HttpMonitor,
  WsChange,
  WsMonitor,
} from "~/monitor";
export type { LoopUntilResult } from "~/workflows/loop-until";
export { loopUntil } from "~/workflows/loop-until";
