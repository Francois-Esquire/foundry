import { createHash } from "node:crypto";
import type {
  HarnessActivityEvent,
  HarnessSession,
} from "@foundry/agents/harness";
import { z } from "zod";
import type { FeedPublisher } from "~/lib/feed/publish";
import { wrapSession } from "./wrapped-session";

const sourceSchema = z.object({
  definition: z.string(),
  path: z.array(z.string()),
  runId: z.string(),
});
export type ActivitySource = z.infer<typeof sourceSchema>;

/** An activity as it is kept, read back through this. */
export const activityRecordSchema = z.object({
  event: z.object({
    actions: z.array(z.literal("stop")).optional(),
    agentId: z.string(),
    harness: z.string(),
    id: z.string(),
    kind: z.enum(["subagent", "task", "watch", "schedule"]),
    lifetime: z.enum(["session", "sandbox"]),
    nativeId: z.string().optional(),
    parentId: z.string().optional(),
    revision: z.number().int().nonnegative(),
    sessionId: z.string(),
    status: z.enum([
      "running",
      "waiting",
      "complete",
      "failed",
      "cancelled",
      "unknown",
    ]),
    summary: z.string().optional(),
    title: z.string(),
  }),
  source: sourceSchema,
});

export interface ActivityRecord {
  readonly event: HarnessActivityEvent;
  readonly source: ActivitySource;
}

/**
 * Where a workspace's harness activities are kept: the Marbles database's
 * for a host (`database/activities.ts`), nowhere but the projection's own
 * memory without one.
 */
export interface ActivityStore {
  /** Every activity kept, its latest revision each. */
  load(): Promise<readonly ActivityRecord[]>;
  /** Keep `record` as the activity `key`, unless a revision as high is kept already. */
  put(key: string, record: ActivityRecord): Promise<void>;
}

/** What an activity is while its harness may still change it. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["running", "waiting"]);
/** What an activity closed out after its process exited says. */
const CLOSED_OUT = "its process exited while it was running";

/** A dashboard projection. The complete activity history remains in the session store. */
export class HarnessActivities {
  readonly #records = new Map<string, ActivityRecord>();
  readonly #sessions = new Map<string, HarnessSession>();
  readonly #observed = new Map<string, Set<string>>();
  readonly #store: ActivityStore | undefined;
  readonly #feed: FeedPublisher | undefined;

  constructor(options: { store?: ActivityStore; feed?: FeedPublisher } = {}) {
    this.#store = options.store;
    this.#feed = options.feed;
  }

  /** Read what the store keeps, before the engine runs anything; without one there is nothing. */
  async load(): Promise<void> {
    for (const record of (await this.#store?.load()) ?? []) {
      const key = this.#key(record);
      // One recorded while this read keeps its place if it is newer.
      const kept = this.#records.get(key);
      if (kept === undefined || kept.event.revision < record.event.revision) {
        this.#records.set(key, record);
      }
    }
  }

  /**
   * Track a live session so its activities can be stopped, and forget it
   * when it closes. Returns the session to hold and close in its place. A
   * `delegated` session is a child task whose session id is also its
   * activity id in the parent, so stopping that activity interrupts it.
   */
  attach(
    sessionId: string,
    session: HarnessSession,
    { delegated = false }: { readonly delegated?: boolean } = {}
  ): HarnessSession {
    const stopActivity = session.stopActivity?.bind(session);
    const tracked = wrapSession(session, {
      close: async () => {
        try {
          await session.close?.();
        } finally {
          if (this.#sessions.get(sessionId) === tracked) {
            this.#sessions.delete(sessionId);
            this.#observed.delete(sessionId);
          }
        }
      },
      ...(delegated
        ? {
            stopActivity: (id: string) => {
              if (id === sessionId) {
                return session.interrupt();
              }
              if (stopActivity) {
                return stopActivity(id);
              }
              return Promise.reject(
                new Error("This activity cannot be stopped.")
              );
            },
          }
        : {}),
    });
    this.#sessions.set(sessionId, tracked);
    this.#observed.set(sessionId, new Set(delegated ? [sessionId] : []));
    return tracked;
  }

  async record(
    event: HarnessActivityEvent,
    source: ActivitySource
  ): Promise<void> {
    const record = { event, source };
    const key = this.#key(record);
    const newer = () => {
      const kept = this.#records.get(key);
      return kept !== undefined && kept.event.revision >= event.revision;
    };
    if (newer()) {
      return;
    }
    await this.#store?.put(key, record);
    // Asked again once the store has it: an overlapping call may have kept
    // a higher revision meanwhile, which the store kept too.
    if (newer()) {
      return;
    }
    const previous = this.#records.get(key);
    this.#records.set(key, record);
    this.#observed.get(event.sessionId)?.add(event.id);
    if (
      previous?.event.status !== event.status &&
      ["complete", "failed"].includes(event.status)
    ) {
      await this.#feed?.publish(
        {
          body: event.summary ?? `${event.kind} ${event.status}.`,
          key: `harness-activity:${key}`,
          kind: "milestone",
          media: [],
          title: `${event.title}: ${event.status}`,
        },
        source
      );
    }
  }

  /**
   * Close out what a process that is gone left running: each activity kept
   * `running` or `waiting` whose run has ended (`ended`), and that no
   * session here reports, is kept `failed`, saying why, at its next
   * revision, with nothing left to stop. Nothing is published: there is no
   * change to tell, only a stale record put right. A store that cannot
   * take one rejects, keeping those closed out so far; running it again
   * closes the rest. Returns how many it closed out.
   */
  async closeOut(ended: (runId: string) => boolean): Promise<number> {
    let closed = 0;
    for (const [key, record] of this.#records) {
      const { event, source } = record;
      if (
        !OPEN_STATUSES.has(event.status) ||
        this.#observed.get(event.sessionId)?.has(event.id) ||
        !ended(source.runId)
      ) {
        continue;
      }
      const next: ActivityRecord = {
        event: {
          ...event,
          actions: [],
          revision: event.revision + 1,
          status: "failed",
          summary: CLOSED_OUT,
        },
        source,
      };
      await this.#store?.put(key, next);
      this.#records.set(key, next);
      closed += 1;
    }
    return closed;
  }

  list(): readonly ActivityRecord[] {
    return [...this.#records.values()].map((record) => {
      if (
        this.#observed.get(record.event.sessionId)?.has(record.event.id) ||
        !OPEN_STATUSES.has(record.event.status)
      ) {
        return record;
      }
      return {
        ...record,
        event: { ...record.event, actions: [], status: "unknown" as const },
      };
    });
  }

  async stop(sessionId: string, activityId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    const activity = this.list().find(
      (record) =>
        record.event.sessionId === sessionId && record.event.id === activityId
    )?.event;
    if (
      !(
        activity?.actions?.includes("stop") &&
        ["running", "waiting"].includes(activity.status) &&
        session?.stopActivity
      )
    ) {
      throw new Error(
        "This activity cannot be stopped through its current harness connection."
      );
    }
    await session.stopActivity(activityId);
  }

  #key({ event, source }: ActivityRecord): string {
    return createHash("sha256")
      .update(
        JSON.stringify([source.runId, source.path, event.sessionId, event.id])
      )
      .digest("hex");
  }
}
