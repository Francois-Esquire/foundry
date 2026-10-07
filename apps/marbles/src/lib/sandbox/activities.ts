import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessActivityEvent,
  HarnessSession,
} from "@foundry/agents/harness";
import { z } from "zod";
import type { FeedPublisher } from "~/lib/feed/publish";
import { readJson, writeJson } from "~/lib/state/json";
import { wrapSession } from "./wrapped-session";

const sourceSchema = z.object({
  definition: z.string(),
  path: z.array(z.string()),
  runId: z.string(),
});
export type ActivitySource = z.infer<typeof sourceSchema>;

const savedSchema = z.object({
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

/** A dashboard projection. The complete activity history remains in the session store. */
export class HarnessActivities {
  readonly #records = new Map<string, ActivityRecord>();
  readonly #sessions = new Map<string, HarnessSession>();
  readonly #observed = new Map<string, Set<string>>();
  readonly #dir: string | undefined;
  readonly #feed: FeedPublisher | undefined;

  constructor(options: { state?: string; feed?: FeedPublisher } = {}) {
    this.#dir = options.state
      ? join(options.state, "harness-activities")
      : undefined;
    this.#feed = options.feed;
    if (this.#dir && existsSync(this.#dir)) {
      for (const file of readdirSync(this.#dir)) {
        if (!file.endsWith(".json")) {
          continue;
        }
        const parsed = savedSchema.safeParse(readJson(join(this.#dir, file)));
        if (parsed.success) {
          const record: ActivityRecord = parsed.data;
          this.#records.set(this.#key(record), record);
        }
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
    const previous = this.#records.get(key);
    if (previous && previous.event.revision >= event.revision) {
      return;
    }
    if (this.#dir) {
      writeJson(join(this.#dir, `${key}.json`), record);
    }
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

  list(): readonly ActivityRecord[] {
    return [...this.#records.values()].map((record) => {
      if (
        this.#observed.get(record.event.sessionId)?.has(record.event.id) ||
        !["running", "waiting"].includes(record.event.status)
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
