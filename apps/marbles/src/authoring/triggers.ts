import { canonicalizeJson } from "@foundry/lib/json";
import { trackCreatedDeclaration } from "~/authoring/runtime";
import { DEFAULT_EVERY, parseAt } from "~/lib/cadence";
import type { AnyDefinition, LockedNode } from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import { MONITOR_META, SCHEDULE_META } from "~/lib/handles";
import { sha256HexSync } from "~/lib/hash";
import { jsonData } from "~/lib/json-data";
import type {
  MonitorHandler,
  MonitorRequest,
  MonitorSpec,
} from "~/lib/monitor";
import type { MonitorRecord } from "~/lib/registry";
import type { CalendarSlot, Schedule, Trigger } from "~/lib/triggers";

const KEY_SEPARATORS = /[^a-z0-9]+/g;
const KEY_TRIM = /^-+|-+$/g;
const KEY_MAX = 40;
const HTTP_SOURCE = /^https?:\/\//;
const WHITESPACE = /\s/;

function triggerSlug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(KEY_SEPARATORS, "-")
    .replace(KEY_TRIM, "")
    .slice(0, KEY_MAX)
    .replace(KEY_TRIM, "");
  return cleaned || "x";
}

export function scheduleKeyBase(workflow: string, input: unknown): string {
  return input === null
    ? triggerSlug(workflow)
    : `${triggerSlug(workflow)}-${sha256HexSync(canonicalizeJson(jsonData(input))).slice(0, 8)}`;
}

export interface ScheduleMeta {
  readonly input: unknown;
  readonly target: AnyDefinition;
}

export interface MonitorMeta {
  readonly explicitKey: boolean;
}

export interface ScheduleBuilder {
  at(slot: CalendarSlot): Schedule;
  every(interval: string): Schedule;
}

export function schedule(target: AnyDefinition | LockedNode): ScheduleBuilder {
  const node = isLockedNode(target) ? target : undefined;
  if (node && node.children.length > 0) {
    throw new Error(
      "schedule(): a locked tree has children; wrap it in a named workflow first"
    );
  }
  const definition = node ? node.definition : (target as AnyDefinition);
  if (
    definition === null ||
    definition === undefined ||
    (definition.kind !== "step" && definition.kind !== "workflow")
  ) {
    throw new TypeError(
      "schedule(): expected a step, workflow, or locked node"
    );
  }
  const literal = node?.literal ?? {};
  const input = Object.keys(literal).length === 0 ? null : literal;
  const create = (trigger: Trigger): Schedule => {
    const workflow = definition.name ?? "";
    const hasInput = input !== null;
    const key = workflow === "" ? "" : scheduleKeyBase(workflow, input);
    let label = "";
    if (workflow !== "") {
      label = hasInput ? `${workflow} ${JSON.stringify(input)}` : workflow;
    }
    const record: Schedule = {
      input,
      key,
      kind: "schedule",
      label,
      trigger,
      workflow,
    };
    Object.defineProperty(record, SCHEDULE_META, {
      value: { input, target: definition } satisfies ScheduleMeta,
    });
    const frozen = Object.freeze(record);
    trackCreatedDeclaration(frozen);
    return frozen;
  };
  return {
    at: (slot) => create(parseAt(slot)),
    every: (interval) => create(parseAt(interval)),
  };
}

export interface MonitorBuilder {
  do(handler: MonitorHandler): MonitorRecord;
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
  const build = (fields: MonitorFields): MonitorBuilder => ({
    do(handler) {
      const trigger = parseAt(fields.every);
      const key =
        fields.key ??
        `${triggerSlug(source)}-${sha256HexSync(source).slice(0, 6)}`;
      const record: MonitorRecord = {
        handler,
        key,
        label: source,
        ...(fields.request === undefined ? {} : { request: fields.request }),
        source: spec,
        trigger,
      };
      Object.defineProperty(record, MONITOR_META, {
        value: { explicitKey: fields.key !== undefined } satisfies MonitorMeta,
      });
      const frozen = Object.freeze(record);
      trackCreatedDeclaration(frozen);
      return frozen;
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
