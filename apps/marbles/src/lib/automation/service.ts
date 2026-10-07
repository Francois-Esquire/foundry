import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { StepFn } from "~/lib/definition";
import type { Detection, Fetch, MonitorInput } from "~/lib/monitor";
import { detector, monitorSpecSchema } from "~/lib/monitor";
import type { Registry } from "~/lib/registry";
import { AUTOMATION_MONITOR } from "~/lib/registry";
import { parseAt } from "~/lib/schedule";
import { validate } from "~/lib/schema";
import { stableJson } from "~/lib/state/json";
import type { StateStore, StoredDocument } from "~/lib/state/store";
import type { Schedule } from "~/lib/triggers";
import { WEEKDAYS } from "~/lib/triggers";

const PATH_SEGMENTS = /[\\/]/;
const weekday = z.enum(WEEKDAYS);
// The raw shape only: `parseAt` is the one judge of a cadence or a slot.
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
const monitorInput = z.object({ id: z.string() });

function sameOwner(a: AutomationOwner, b: AutomationOwner): boolean {
  return a.sessionId === b.sessionId && a.agentId === b.agentId;
}

/** HTTP monitors agents create never follow a redirect off the permitted URL. */
const noRedirects: Fetch = async (url, init) =>
  await fetch(url, { ...init, redirect: "error" });

/**
 * One stored automation as last read: its record when it parsed, and why it
 * cannot run when it cannot (unreadable, or a source the host refuses).
 */
interface Loaded {
  readonly error?: string;
  readonly record?: AutomationRecord;
}

export interface AutomationOptions {
  /** HTTP polling is disabled unless the host explicitly permits the URL. */
  readonly allowHttp?: (url: URL) => boolean;
  /** Where targets are looked up and the triggers agents create are registered. */
  readonly registry: Registry;
  /**
   * Where records live, one `automations` document per id, and where edits
   * are locked. Another process sharing it sees each change.
   */
  readonly store: StateStore;
}

/**
 * Declarative trigger storage. Execution stays in the host's existing
 * schedule loop. The store is the one source: every read first checks its
 * revision and re-reads only when a record was written or removed, by this
 * service or another process.
 */
export class AutomationService {
  readonly #options: AutomationOptions;
  readonly #registry: Registry;
  readonly #store: StateStore;
  #loaded = new Map<string, Loaded>();
  #revision: string | undefined;

  constructor(options: AutomationOptions) {
    this.#options = options;
    this.#registry = options.registry;
    this.#store = options.store;
    // One step polls every agent-created monitor, by id: the Orchestrator
    // takes its factories before it starts and never lets one go.
    const poll: StepFn<z.infer<typeof monitorInput>, Detection> = async (
      context
    ) => {
      this.#refresh();
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
    this.#refresh();
  }

  /** Re-read the store if it changed since the last read, and re-register what it holds. */
  #refresh(): void {
    const revision = this.#store.revision("automations");
    if (revision === this.#revision) {
      return;
    }
    this.#revision = revision;
    const loaded = new Map(
      this.#store
        .list("automations")
        .map((document) => [document.key, this.#load(document)] as const)
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

  #load(document: StoredDocument): Loaded {
    if (document.error !== undefined) {
      return { error: document.error };
    }
    let record: AutomationRecord;
    try {
      const parsed = recordSchema.parse(document.value);
      // Earlier records lacked a creation timestamp. When the store last
      // wrote them gives a stable first deadline until the next edit.
      record = {
        ...parsed,
        createdAt:
          parsed.createdAt ?? new Date(document.modified).toISOString(),
      };
    } catch (error) {
      return { error: String(error) };
    }
    if (record.id !== document.key) {
      return {
        error: `Automation "${document.key}" holds the record of ${record.id}`,
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

  /** Why each stored automation that cannot run does not, by id. */
  errors(): Readonly<Record<string, string>> {
    this.#refresh();
    return Object.fromEntries(
      [...this.#loaded].flatMap(([id, { error }]) =>
        error === undefined ? [] : [[id, error]]
      )
    );
  }

  #edit<T>(id: string, action: () => T): T {
    recordSchema.shape.id.parse(id);
    const lock = this.#store.lock(`edit-${id}`);
    if ("holder" in lock) {
      throw new Error(
        "Automation is being edited by another host; retry the operation"
      );
    }
    try {
      this.#refresh();
      return action();
    } finally {
      lock.release();
    }
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
    // Throws on an unreadable cadence or slot before anything is saved.
    parseAt(spec.at);
  }

  /** The store's next revision registers it, here and in every other host. */
  #save(record: AutomationRecord): void {
    this.#store.write("automations", record.id, record);
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

  list(owner?: AutomationOwner): readonly AutomationRecord[] {
    this.#refresh();
    return structuredClone(
      this.#records().filter(
        (record) => !owner || sameOwner(record.owner, owner)
      )
    );
  }

  schedules(): readonly Schedule[] {
    this.#refresh();
    return [...this.#registry.schedules.values()];
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
      .update(stableJson([owner.agentId, owner.sessionId, spec.key]))
      .digest("hex")
      .slice(0, 24)}`;
    return this.#edit(creationKey, () => {
      const previous = this.#records().find(
        (existing) =>
          existing.key === spec.key && sameOwner(existing.owner, owner)
      );
      if (previous) {
        if (stableJson(specSchema.parse(previous)) !== stableJson(spec)) {
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
      this.#store.remove("automations", id);
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
        execute: async () => this.#registry.entries(),
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

/** What the loop runs for a record: its target, or the shared monitor step polling it. */
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
