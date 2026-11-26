import { createHash } from "node:crypto";
import { canonicalizeJson } from "@foundry/lib/json";
import { captureScope, declaringCatalog } from "~/authoring/runtime";
import type { AnyDefinition, LockedNode } from "~/lib/definition";
import { launchTarget } from "~/lib/launch";
import type {
  MonitorHandler,
  MonitorRequest,
  MonitorSpec,
} from "~/lib/monitor";
import { DEFAULT_EVERY } from "~/lib/monitor";
import { parseAt } from "~/lib/schedule";
import { jsonData } from "~/lib/state/json";
import type { CalendarSlot, Trigger } from "~/lib/triggers";

const KEY_SEPARATORS = /[^a-z0-9]+/g;
const KEY_TRIM = /^-+|-+$/g;
const KEY_MAX = 40;
const HTTP_SOURCE = /^https?:\/\//;
const WHITESPACE = /\s/;

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

export interface ScheduleBuilder {
  at(slot: CalendarSlot): void;
  every(interval: string): void;
}

export function schedule(target: AnyDefinition | LockedNode): ScheduleBuilder {
  const launch = launchTarget(target, "schedule()");
  const scope = captureScope();
  const register = (trigger: Trigger) => {
    const hasInput = launch.input !== null;
    const base = hasInput
      ? `${slug(launch.workflow)}-${sha256(canonicalizeJson(jsonData(launch.input))).slice(0, 8)}`
      : slug(launch.workflow);
    const into = scope(declaringCatalog);
    into.schedule({
      input: launch.input,
      key: into.uniqueKey(base),
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
  do(handler: MonitorHandler): void;
  every(interval: string): MonitorBuilder;
  name(key: string): MonitorBuilder;
  request(init: MonitorRequest): MonitorBuilder;
}

interface MonitorFields {
  readonly every: string;
  readonly key?: string;
  readonly request?: MonitorRequest;
}

export function monitor(source: string): MonitorBuilder {
  if (!source.trim()) {
    throw new Error("monitor(): a source is required");
  }
  const spec: MonitorSpec = HTTP_SOURCE.test(source)
    ? { kind: "http", url: source }
    : { glob: source, kind: "files" };
  const scope = captureScope();
  const build = (fields: MonitorFields): MonitorBuilder => ({
    do(handler) {
      const trigger = parseAt(fields.every);
      const into = scope(declaringCatalog);
      const key =
        fields.key ??
        into.uniqueKey(`${slug(source)}-${sha256(source).slice(0, 6)}`);
      into.monitor({
        handler,
        key,
        label: source,
        ...(fields.request === undefined ? {} : { request: fields.request }),
        source: spec,
        trigger,
      });
    },
    every(interval) {
      parseAt(interval);
      return build({ ...fields, every: interval });
    },
    name(key) {
      if (typeof key !== "string" || !key.trim()) {
        throw new Error(`monitor("${source}").name(): a name cannot be blank`);
      }
      if (WHITESPACE.test(key)) {
        throw new Error(
          `monitor("${source}").name(${JSON.stringify(key)}): a name is one word, as \`marbles trigger <name>\` takes it`
        );
      }
      return build({ ...fields, key });
    },
    request(init) {
      if (spec.kind !== "http") {
        throw new Error(
          `monitor("${source}").request(): only an http or https source sends a request`
        );
      }
      return build({ ...fields, request: init });
    },
  });
  return build({ every: DEFAULT_EVERY });
}
