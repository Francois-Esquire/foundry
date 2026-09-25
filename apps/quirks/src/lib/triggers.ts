import type { MonitorHandler, MonitorOptions } from "~/monitor";
import { DEFAULT_EVERY, detector, resolveMonitor } from "~/monitor";
import { parseAt } from "~/schedule";

import { step } from "./builder";
import { catalog } from "./catalog";
import type { AnyDefinition } from "./definition";

/**
 * Triggers, phase 1: the current named factories, pointed at the new
 * definitions. A schedule names a launchable definition; a monitor
 * registers a detector step under its own name plus a schedule that polls
 * it. The trigger redesign in `_api-alt.md` lands with the identity spike.
 */

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/** A wall-clock slot in machine-local time; no `weekday` means every day. */
export interface CalendarSlot {
  readonly hour: number;
  /** Defaults to 0. */
  readonly minute?: number;
  readonly weekday?: Weekday | readonly Weekday[];
}

export type Trigger =
  | { readonly kind: "interval"; readonly ms: number }
  | { readonly kind: "calendar"; readonly slot: CalendarSlot };

export interface Schedule {
  readonly input: unknown;
  /** Set when `monitor()` registered it; the step is a change detector. */
  readonly kind?: "monitor";
  readonly name: string;
  readonly trigger: Trigger;
  /** The launchable definition's name. */
  readonly workflow: string;
}

export interface ScheduleOptions {
  /** An interval (`"30m" | "6h" | "1d"`) or a calendar slot (`{ weekday: "mon", hour: 9 }`). */
  readonly at: string | CalendarSlot;
  readonly input?: unknown;
  readonly workflow: AnyDefinition | string;
}

export function schedule(name: string, options: ScheduleOptions): void {
  const target =
    typeof options.workflow === "string"
      ? options.workflow
      : options.workflow.name;
  if (target === undefined) {
    throw new Error(
      `schedule "${name}": only a named step or workflow can be scheduled`
    );
  }
  catalog.schedule({
    input: options.input ?? null,
    name,
    trigger: parseAt(options.at),
    workflow: target,
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
  if (catalog.definitions.has(name) || catalog.schedules.has(name)) {
    throw new Error(`"${name}" already registered`);
  }
  const spec = resolveMonitor(options);
  step(name).do(detector(name, spec, handler));
  catalog.monitor(name, spec, {
    input: null,
    kind: "monitor",
    name,
    trigger: parseAt(
      (spec.kind === "ws" ? undefined : spec.every) ?? DEFAULT_EVERY
    ),
    workflow: name,
  });
}
