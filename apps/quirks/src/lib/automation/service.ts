import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { Catalog } from "~/lib/catalog";
import type { StepFn } from "~/lib/definition";
import { type Detection, detector, type MonitorInput } from "~/lib/monitor";
import { parseAt } from "~/lib/schedule";
import { validate } from "~/lib/schema";
import { stableJson, writeJson } from "~/lib/state/json";
import { acquireLock } from "~/lib/state/locks";
import type { Schedule } from "~/lib/triggers";

const PATH_SEGMENTS = /[\\/]/;
const weekday = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const cadence = z.union([
  z.string().regex(/^[1-9]\d*[smhd]$/),
  z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59).optional(),
    weekday: z.union([weekday, z.array(weekday).min(1)]).optional(),
  }),
]);
const source = z.discriminatedUnion("kind", [
  z.object({ glob: z.string().min(1), kind: z.literal("files") }),
  z.object({ kind: z.literal("http"), url: z.string().url() }),
]);
const specSchema = z.object({
  at: cadence,
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  key: z.string().min(1).max(120),
  source: source.optional(),
  workflow: z.string().min(1),
});
const ownerSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  source: z.object({
    definition: z.string(),
    path: z.array(z.string()),
    runId: z.string(),
  }),
});
const recordSchema = specSchema.extend({
  createdAt: z.iso.datetime().optional(),
  enabled: z.boolean(),
  id: z.string().regex(/^automation-[a-f0-9]{24}$/),
  owner: ownerSchema,
  version: z.literal(1),
});
export type AutomationOwner = z.infer<typeof ownerSchema>;
export type AutomationSpec = z.infer<typeof specSchema>;
export type AutomationRecord = z.infer<typeof recordSchema> & {
  readonly createdAt: string;
};
export const AUTOMATION_MONITOR = "__automation_monitor";

const monitorInput = z.object({ id: z.string() });

export interface AutomationOptions {
  /** HTTP polling is disabled unless the host explicitly permits the URL. */
  readonly allowHttp?: (url: URL) => boolean;
  /** Where targets are looked up and the triggers agents create are registered. */
  readonly catalog: Catalog;
  readonly state?: string;
}

/** Declarative trigger storage. Execution stays in the host's existing schedule loop. */
export class AutomationService {
  readonly #options: AutomationOptions;
  readonly #catalog: Catalog;
  readonly #records = new Map<string, AutomationRecord>();
  readonly #errors = new Map<string, string>();
  readonly #detectors = new Map<string, StepFn<MonitorInput, Detection>>();

  constructor(options: AutomationOptions) {
    this.#options = options;
    this.#catalog = options.catalog;
    const poll: StepFn<z.infer<typeof monitorInput>, Detection> = async (
      context
    ) => {
      this.#refresh();
      const record = this.#records.get(context.input.id);
      if (
        !(record?.enabled && record.source) ||
        this.#errors.has(`${record.id}.json`)
      ) {
        return { changed: false };
      }
      return await this.#detectorFor(
        record,
        record.source
      )({
        ...context,
        input: {},
      });
    };
    this.#catalog.definitions.delete(AUTOMATION_MONITOR);
    this.#catalog.register({
      fn: poll,
      input: monitorInput,
      kind: "step",
      name: AUTOMATION_MONITOR,
    });
    this.#refresh();
  }

  #detectorFor(
    record: AutomationRecord,
    watched: NonNullable<AutomationRecord["source"]>
  ): StepFn<MonitorInput, Detection> {
    const existing = this.#detectors.get(record.id);
    if (existing) {
      return existing;
    }
    const target = this.#catalog.definitions.get(record.workflow);
    if (!target) {
      throw new Error(
        `Automation target "${record.workflow}" is not registered`
      );
    }
    // The detector uses the canonical pending-launch/acknowledgement protocol.
    const poll = detector(
      record.id,
      watched,
      () => ({
        children: [],
        definition: target,
        kind: "node",
        literal: record.input ?? {},
        mode: "series",
      }),
      {
        fetch: async (url, init) =>
          await fetch(url, { ...init, redirect: "error" }),
      }
    );
    this.#detectors.set(record.id, poll);
    return poll;
  }

  #refresh(): void {
    const directory = this.#directory();
    if (!directory) {
      return;
    }
    const records = new Map<string, AutomationRecord>();
    this.#errors.clear();
    for (const file of existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith(".json"))
      : []) {
      try {
        const path = join(directory, file);
        const parsed = recordSchema.parse(
          JSON.parse(readFileSync(path, "utf8"))
        );
        // Earlier records lacked a creation timestamp. Their persisted modification
        // time provides a stable first deadline until the next edit writes it.
        const record: AutomationRecord = {
          ...parsed,
          createdAt: parsed.createdAt ?? statSync(path).mtime.toISOString(),
        };
        if (file !== `${record.id}.json`) {
          throw new Error(`Invalid automation filename ${file}`);
        }
        records.set(record.id, record);
        this.#checkSource(record);
      } catch (error) {
        this.#errors.set(file, String(error));
      }
    }
    for (const id of this.#records.keys()) {
      if (!records.has(id)) {
        this.#catalog.schedules.delete(id);
        this.#detectors.delete(id);
      }
    }
    this.#records.clear();
    for (const [id, record] of records) {
      this.#records.set(id, record);
      if (this.#errors.has(`${id}.json`)) {
        this.#catalog.schedules.delete(id);
      } else {
        this.#register(record);
      }
    }
  }

  errors(): Readonly<Record<string, string>> {
    this.#refresh();
    return Object.fromEntries(this.#errors);
  }

  #edit<T>(id: string, action: () => T): T {
    recordSchema.shape.id.parse(id);
    const { state } = this.#options;
    const lock =
      state === undefined ? undefined : acquireLock(state, `edit-${id}`);
    if (typeof lock === "number") {
      throw new Error(
        "Automation is being edited by another host; retry the operation"
      );
    }
    try {
      this.#refresh();
      return action();
    } finally {
      lock?.release();
    }
  }

  #directory(): string | undefined {
    return this.#options.state === undefined
      ? undefined
      : join(this.#options.state, "automations");
  }
  #checkSource(spec: AutomationSpec): void {
    if (
      spec.source?.kind === "files" &&
      (isAbsolute(spec.source.glob) ||
        spec.source.glob.split(PATH_SEGMENTS).includes(".."))
    ) {
      throw new Error(
        "File monitors must use a workspace-relative glob without parent traversal"
      );
    }
    if (spec.source?.kind === "http") {
      const url = new URL(spec.source.url);
      if (
        !(
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          this.#options.allowHttp?.(url)
        )
      ) {
        throw new Error("HTTP monitor URL is not permitted by the host");
      }
    }
    const trigger = parseAt(spec.at);
    if (
      trigger.kind === "interval" &&
      (!Number.isSafeInteger(trigger.ms) || trigger.ms <= 0)
    ) {
      throw new Error("Automation cadence must be a positive safe interval");
    }
  }
  #register(record: AutomationRecord): void {
    this.#catalog.schedules.delete(record.id);
    if (!record.enabled) {
      return;
    }
    this.#catalog.schedule({
      input: record.source ? { id: record.id } : (record.input ?? null),
      key: record.id,
      kind: record.source ? "monitor" : "schedule",
      label: record.key,
      registeredAt: Date.parse(record.createdAt),
      trigger: parseAt(record.at),
      workflow: record.source ? AUTOMATION_MONITOR : record.workflow,
    });
  }
  #save(record: AutomationRecord): void {
    const directory = this.#directory();
    if (directory) {
      writeJson(join(directory, `${record.id}.json`), record);
    }
    this.#records.set(record.id, record);
    this.#register(record);
  }
  #owned(id: string, owner?: AutomationOwner): AutomationRecord {
    const record = this.#records.get(id);
    if (
      !record ||
      (owner &&
        (record.owner.sessionId !== owner.sessionId ||
          record.owner.agentId !== owner.agentId))
    ) {
      throw new Error(
        "Automation is missing or belongs to another agent session"
      );
    }
    return record;
  }
  list(owner?: AutomationOwner): readonly AutomationRecord[] {
    this.#refresh();
    return structuredClone(
      [...this.#records.values()].filter(
        (record) =>
          !owner ||
          (record.owner.sessionId === owner.sessionId &&
            record.owner.agentId === owner.agentId)
      )
    );
  }
  schedules(): readonly Schedule[] {
    this.#refresh();
    return [...this.#catalog.schedules.values()];
  }
  async create(
    raw: AutomationSpec,
    rawOwner: AutomationOwner
  ): Promise<AutomationRecord> {
    const spec = specSchema.parse(raw);
    const owner = ownerSchema.parse(rawOwner);
    this.#checkSource(spec);
    const target = this.#catalog.definitions.get(spec.workflow);
    if (
      !target ||
      spec.workflow === AUTOMATION_MONITOR ||
      this.#catalog.monitors.has(spec.workflow)
    ) {
      throw new Error(`Automation target "${spec.workflow}" is not launchable`);
    }
    if (target.input) {
      await validate(
        target.input,
        spec.input ?? {},
        `"${spec.workflow}" input`
      );
    }
    const creationKey = `automation-${createHash("sha256")
      .update(stableJson([owner.agentId, owner.sessionId, spec.key]))
      .digest("hex")
      .slice(0, 24)}`;
    return this.#edit(creationKey, () => {
      const previous = [...this.#records.values()].find(
        (existing) =>
          existing.key === spec.key &&
          existing.owner.sessionId === owner.sessionId &&
          existing.owner.agentId === owner.agentId
      );
      if (previous) {
        const {
          createdAt: _____,
          id: _,
          enabled: __,
          owner: ___,
          version: ____,
          ...previousSpec
        } = previous;
        if (stableJson(previousSpec) !== stableJson(spec)) {
          throw new Error(
            "Automation key already exists with different settings"
          );
        }
        return structuredClone(previous);
      }
      const record: AutomationRecord = {
        ...spec,
        createdAt: new Date().toISOString(),
        enabled: true,
        id: `automation-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        owner,
        version: 1,
      };
      this.#save(record);
      return structuredClone(record);
    });
  }
  setEnabled(
    id: string,
    enabled: boolean,
    owner?: AutomationOwner
  ): AutomationRecord {
    return this.#edit(id, () => {
      const record = { ...this.#owned(id, owner), enabled };
      if (enabled) {
        this.#checkSource(record);
      }
      this.#save(record);
      return structuredClone(record);
    });
  }
  delete(id: string, owner?: AutomationOwner): void {
    this.#edit(id, () => {
      this.#owned(id, owner);
      const directory = this.#directory();
      if (directory) {
        unlinkSync(join(directory, `${id}.json`));
      }
      this.#records.delete(id);
      this.#detectors.delete(id);
      this.#catalog.schedules.delete(id);
    });
  }
  tools(owner: AutomationOwner): ToolSet {
    return {
      create_automation: tool({
        description:
          "Create an idempotent persistent schedule or change monitor targeting a registered workflow. Calendar times use the host machine local timezone. HTTP monitoring requires host permission; file globs stay within the workspace.",
        execute: async (input) => await this.create(input, owner),
        inputSchema: specSchema,
      }),
      delete_automation: tool({
        description:
          "Delete this session's automation. A running workflow continues.",
        execute: async ({ id }) => {
          this.delete(id, owner);
          return { deleted: true };
        },
        inputSchema: z.object({ id: z.string() }),
      }),
      list_automation_targets: tool({
        description: "List registered launch targets and their input schemas.",
        execute: async () =>
          this.#catalog
            .entries()
            .filter((entry) => entry.name !== AUTOMATION_MONITOR),
        inputSchema: z.object({}),
      }),
      list_automations: tool({
        description: "List schedules and monitors owned by this agent session.",
        execute: async () => this.list(owner),
        inputSchema: z.object({}),
      }),
      set_automation_enabled: tool({
        description:
          "Pause or resume this session's automation. A running workflow continues.",
        execute: async ({ id, enabled }) => this.setEnabled(id, enabled, owner),
        inputSchema: z.object({ enabled: z.boolean(), id: z.string() }),
      }),
    };
  }
}
