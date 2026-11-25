import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalizeJson } from "@foundry/lib/json";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { StepFn } from "~/lib/definition";
import type { Detection, Fetch, MonitorInput } from "~/lib/monitor";
import { detector, monitorSpecSchema } from "~/lib/monitor";
import type { Registry } from "~/lib/registry";
import { AUTOMATION_MONITOR } from "~/lib/registry";
import { parseAt } from "~/lib/schedule";
import { validate } from "~/lib/schema";
import { jsonData } from "~/lib/state/json";
import type { Schedule } from "~/lib/triggers";
import { WEEKDAYS } from "~/lib/triggers";
import type {
  AutomationStore,
  AutomationView,
  StoredAutomation,
} from "./store";

const PATH_SEGMENTS = /[\\/]/;
const weekday = z.enum(WEEKDAYS);
const cadence = z
  .union([
    z.string(),
    z.object({
      hour: z.number(),
      minute: z.number().optional(),
      weekday: z.union([weekday, z.array(weekday).min(1)]).optional(),
    }),
  ])
  .describe(
    'An interval such as "30m", "6h" or "1d", or a local calendar slot { hour: 0-23, minute?: 0-59, weekday? }'
  );
const specSchema = z.object({
  at: cadence,
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  key: z.string().min(1).max(120),
  source: monitorSpecSchema.optional(),
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
  createdAt: z.iso.datetime(),
  enabled: z.boolean(),
  id: z.string().regex(/^automation-[a-f0-9]{24}$/),
  owner: ownerSchema,
  version: z.literal(1),
});
export type AutomationOwner = z.infer<typeof ownerSchema>;
export type AutomationSpec = z.infer<typeof specSchema>;
export type AutomationRecord = z.infer<typeof recordSchema>;
const monitorInput = z.object({ id: z.string() });

function sameOwner(a: AutomationOwner, b: AutomationOwner): boolean {
  return a.sessionId === b.sessionId && a.agentId === b.agentId;
}

const noRedirects: Fetch = async (url, init) =>
  await fetch(url, { ...init, redirect: "error" });

interface Loaded {
  readonly error?: string;
  readonly record?: AutomationRecord;
}

export interface AutomationOptions {
  readonly allowHttp?: (url: URL) => boolean;
  readonly registry: Registry;
  readonly store: AutomationStore;
}

export class AutomationService {
  readonly #options: AutomationOptions;
  readonly #registry: Registry;
  readonly #store: AutomationStore;
  #loaded = new Map<string, Loaded>();
  #read: string | undefined;
  #reading: Promise<void> = Promise.resolve();

  constructor(options: AutomationOptions) {
    this.#options = options;
    this.#registry = options.registry;
    this.#store = options.store;
    const poll: StepFn<z.infer<typeof monitorInput>, Detection> = async (
      context
    ) => {
      await this.#refresh();
      const { error, record } = this.#loaded.get(context.input.id) ?? {};
      if (error !== undefined || !(record?.enabled && record.source)) {
        return { changed: false };
      }
      if (!this.#registry.definitions.has(record.workflow)) {
        throw new Error(
          `Automation target "${record.workflow}" is not registered`
        );
      }
      const body = detector(
        record.id,
        record.source,
        () => ({ input: record.input ?? null, workflow: record.workflow }),
        { fetch: noRedirects }
      );
      const input: MonitorInput = {};
      return await body({ ...context, input });
    };
    this.#registry.define({
      fn: poll,
      input: monitorInput,
      kind: "step",
      name: AUTOMATION_MONITOR,
    });
  }

  #refresh(): Promise<void> {
    const reading = this.#reading.then(async () =>
      this.#take(await this.#store.list())
    );
    this.#reading = reading.catch(() => undefined);
    return reading;
  }

  #take(stored: readonly StoredAutomation[]): void {
    const read = JSON.stringify(stored);
    if (read === this.#read) {
      return;
    }
    this.#read = read;
    const loaded = new Map(
      stored.map(
        (automation) => [automation.id, this.#load(automation)] as const
      )
    );
    for (const id of this.#loaded.keys()) {
      this.#registry.unschedule(id);
    }
    this.#loaded = loaded;
    for (const { error, record } of loaded.values()) {
      if (record?.enabled && error === undefined) {
        this.#registry.schedule(scheduleOf(record));
      }
    }
  }

  #load(stored: StoredAutomation): Loaded {
    let record: AutomationRecord;
    try {
      record = recordSchema.parse(stored.value);
    } catch (error) {
      return { error: String(error) };
    }
    if (record.id !== stored.id) {
      return {
        error: `Automation "${stored.id}" holds the record of ${record.id}`,
      };
    }
    try {
      this.#checkSource(record);
      return { record };
    } catch (error) {
      return { error: String(error), record };
    }
  }

  #records(): AutomationRecord[] {
    return [...this.#loaded.values()].flatMap(({ record }) =>
      record ? [record] : []
    );
  }

  async errors(): Promise<Readonly<Record<string, string>>> {
    await this.#refresh();
    return Object.fromEntries(
      [...this.#loaded].flatMap(([id, { error }]) =>
        error === undefined ? [] : [[id, error]]
      )
    );
  }

  async #edit<T>(
    id: string,
    action: (view: AutomationView) => Promise<T>
  ): Promise<T> {
    recordSchema.shape.id.parse(id);
    const result = await this.#store.edit(async (view) => {
      this.#take(await view.list());
      return await action(view);
    });
    await this.#refresh();
    return result;
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
    parseAt(spec.at);
  }

  #owned(id: string, owner?: AutomationOwner): AutomationRecord {
    const { record } = this.#loaded.get(id) ?? {};
    if (!record || (owner && !sameOwner(record.owner, owner))) {
      throw new Error(
        "Automation is missing or belongs to another agent session"
      );
    }
    return record;
  }

  async list(owner?: AutomationOwner): Promise<readonly AutomationRecord[]> {
    await this.#refresh();
    return structuredClone(
      this.#records().filter(
        (record) => !owner || sameOwner(record.owner, owner)
      )
    );
  }

  async schedules(): Promise<readonly Schedule[]> {
    await this.#refresh();
    return [...this.#registry.schedules.values()];
  }

  async paused(): Promise<readonly Schedule[]> {
    await this.#refresh();
    return [...this.#loaded.values()].flatMap(({ error, record }) =>
      record !== undefined && !record.enabled && error === undefined
        ? [scheduleOf(record)]
        : []
    );
  }

  async create(
    raw: AutomationSpec,
    rawOwner: AutomationOwner
  ): Promise<AutomationRecord> {
    const spec = specSchema.parse(raw);
    const owner = ownerSchema.parse(rawOwner);
    this.#checkSource(spec);
    const target = this.#registry.definitions.get(spec.workflow);
    if (
      !target ||
      spec.workflow === AUTOMATION_MONITOR ||
      this.#registry.monitors.has(spec.workflow)
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
      .update(canonicalizeJson([owner.agentId, owner.sessionId, spec.key]))
      .digest("hex")
      .slice(0, 24)}`;
    return await this.#edit(creationKey, async (view) => {
      const previous = this.#records().find(
        (existing) =>
          existing.key === spec.key && sameOwner(existing.owner, owner)
      );
      if (previous) {
        if (
          canonicalizeJson(jsonData(specSchema.parse(previous))) !==
          canonicalizeJson(jsonData(spec))
        ) {
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
      await view.put(record);
      return structuredClone(record);
    });
  }

  setEnabled(
    id: string,
    enabled: boolean,
    owner?: AutomationOwner
  ): Promise<AutomationRecord> {
    return this.#edit(id, async (view) => {
      const record = { ...this.#owned(id, owner), enabled };
      if (enabled) {
        this.#checkSource(record);
      }
      await view.put(record);
      return structuredClone(record);
    });
  }

  delete(id: string, owner?: AutomationOwner): Promise<void> {
    return this.#edit(id, async (view) => {
      this.#owned(id, owner);
      await view.remove(id);
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
          await this.delete(id, owner);
          return { deleted: true };
        },
        inputSchema: z.object({ id: z.string() }),
      }),
      list_automation_targets: tool({
        description: "List registered launch targets and their input schemas.",
        execute: async () => this.#registry.entries(),
        inputSchema: z.object({}),
      }),
      list_automations: tool({
        description: "List schedules and monitors owned by this agent session.",
        execute: async () => await this.list(owner),
        inputSchema: z.object({}),
      }),
      set_automation_enabled: tool({
        description:
          "Pause or resume this session's automation. A running workflow continues.",
        execute: async ({ id, enabled }) =>
          await this.setEnabled(id, enabled, owner),
        inputSchema: z.object({ enabled: z.boolean(), id: z.string() }),
      }),
    };
  }
}

function scheduleOf(record: AutomationRecord): Schedule {
  return {
    input: record.source ? { id: record.id } : (record.input ?? null),
    key: record.id,
    kind: record.source ? "monitor" : "schedule",
    label: record.key,
    registeredAt: Date.parse(record.createdAt),
    trigger: parseAt(record.at),
    workflow: record.source ? AUTOMATION_MONITOR : record.workflow,
  };
}
