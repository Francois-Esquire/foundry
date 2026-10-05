import { createHash } from "node:crypto";
import { catalog } from "~/authoring/catalog";
import type { AnyDefinition, LockedNode } from "~/lib/definition";
import { launchTarget } from "~/lib/launch";
import type { MonitorHandler, MonitorSpec } from "~/lib/monitor";
import { DEFAULT_EVERY } from "~/lib/monitor";
import { parseAt } from "~/lib/schedule";
import { stableJson } from "~/lib/state/json";
import type { CalendarSlot, Trigger } from "~/lib/triggers";

/**
 * Triggers. A schedule takes a definition, bare or locked, and a cadence; a
 * monitor takes one source string and a handler. Neither has a name of its
 * own: a schedule is known by its target and input, a monitor by its source.
 * Those keys name the state files, the launchd label, and `once <key>`.
 */

const KEY_SEPARATORS = /[^a-z0-9]+/g;
const KEY_TRIM = /^-+|-+$/g;
const KEY_MAX = 40;
const HTTP_SOURCE = /^https?:\/\//;

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(KEY_SEPARATORS, "-")
    .replace(KEY_TRIM, "")
    .slice(0, KEY_MAX)
    .replace(KEY_TRIM, "");
  return cleaned || "x";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Registration-order suffix for an exact duplicate key. */
function uniqueKey(base: string): string {
  if (!catalog.schedules.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!catalog.schedules.has(candidate)) {
      return candidate;
    }
  }
}

export interface ScheduleBuilder {
  /** A calendar slot: `{ weekday: "fri", hour: 16 }`. */
  at(slot: CalendarSlot): void;
  /** An interval: `"30m" | "6h" | "1d"`. */
  every(interval: string): void;
}

export function schedule(target: AnyDefinition | LockedNode): ScheduleBuilder {
  const launch = launchTarget(target, "schedule()");
  const register = (trigger: Trigger) => {
    const hasInput = launch.input !== null;
    const base = hasInput
      ? `${slug(launch.workflow)}-${sha256(stableJson(launch.input)).slice(0, 8)}`
      : slug(launch.workflow);
    catalog.schedule({
      input: launch.input,
      key: uniqueKey(base),
      kind: "schedule",
      label: hasInput
        ? `${launch.workflow} ${JSON.stringify(launch.input)}`
        : launch.workflow,
      trigger,
      workflow: launch.workflow,
    });
  };
  return {
    at(slot) {
      register(parseAt(slot));
    },
    every(interval) {
      register(parseAt(interval));
    },
  };
}

export interface MonitorBuilder {
  /** The handler; a locked node returned from it is started. */
  do(handler: MonitorHandler): void;
  /** Poll cadence; defaults to every minute. */
  every(interval: string): MonitorBuilder;
}

/**
 * One string: `http://` or `https://` is polled and fires when the body
 * changes; anything else is a glob over the config's directory and fires
 * when a matching file changes.
 */
export function monitor(source: string): MonitorBuilder {
  if (!source.trim()) {
    throw new Error("monitor(): a source is required");
  }
  const spec: MonitorSpec = HTTP_SOURCE.test(source)
    ? { kind: "http", url: source }
    : { glob: source, kind: "files" };
  const build = (every: string): MonitorBuilder => ({
    do(handler) {
      const trigger = parseAt(every);
      const key = uniqueKey(`${slug(source)}-${sha256(source).slice(0, 6)}`);
      catalog.monitor({ handler, key, label: source, source: spec, trigger });
    },
    every(interval) {
      parseAt(interval);
      return build(interval);
    },
  });
  return build(DEFAULT_EVERY);
}
