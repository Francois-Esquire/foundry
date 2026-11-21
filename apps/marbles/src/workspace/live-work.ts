import type { SessionStore } from "@foundry/agents/store";
import type { RunRecord } from "@foundry/workflows/schema";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { ReadonlyRunScopes } from "~/lib/run-scope";
import type { LiveWork } from "~/lib/step-work";
import type { LiveRun } from "~/model/dashboard";

const MAX_DELEGATION_DEPTH = 8;

export function liveRuns(
  records: readonly RunRecord[],
  scopes: ReadonlyRunScopes
): readonly LiveRun[] {
  return records.flatMap((record) => {
    const scope = scopes.get(record.id);
    return scope === undefined ? [] : [{ record, work: scope.work() }];
  });
}

export interface LiveView {
  readonly records: readonly RunRecord[];
  readonly work: ReadonlyMap<string, readonly LiveWork[]>;
}

export function liveView(
  records: readonly RunRecord[],
  scopes: ReadonlyRunScopes,
  elsewhere: readonly LiveRun[] = []
): LiveView {
  const work = new Map(
    [...scopes].map((scope) => [scope.id, scope.work()] as const)
  );
  const owned = new Map<string, RunRecord>();
  for (const run of elsewhere) {
    if (!work.has(run.record.id)) {
      owned.set(run.record.id, run.record);
      work.set(run.record.id, run.work);
    }
  }
  const listed = new Set(records.map((record) => record.id));
  return {
    records: [
      ...records.map((record) => owned.get(record.id) ?? record),
      ...[...owned.values()].filter((record) => !listed.has(record.id)),
    ],
    work,
  };
}

async function delegatingTurn(
  sessions: Pick<SessionStore, "getSession">,
  asking: string,
  running: ReadonlySet<string>
): Promise<string | undefined> {
  let session = asking;
  for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth += 1) {
    const parent = (await sessions.getSession(session).catch(() => null))
      ?.parentSessionId;
    if (!parent) {
      return;
    }
    if (running.has(parent)) {
      return parent;
    }
    session = parent;
  }
}

export async function questionOwners(
  sessions: Pick<SessionStore, "getSession">,
  feed: readonly FeedEntrySnapshot[],
  live: ReadonlyMap<string, readonly LiveWork[]>
): Promise<ReadonlyMap<string, string>> {
  const running = new Set(
    [...live.values()]
      .flat()
      .flatMap((work) => (work.kind === "agent" ? [work.sessionId] : []))
  );
  const asking = new Set(
    feed.flatMap((entry) =>
      entry.kind === "input" &&
      entry.input?.status === "open" &&
      entry.input.sessionId !== undefined &&
      live.has(entry.run) &&
      !running.has(entry.input.sessionId)
        ? [entry.input.sessionId]
        : []
    )
  );
  const owners = new Map<string, string>();
  for (const session of asking) {
    const owner = await delegatingTurn(sessions, session, running);
    if (owner !== undefined) {
      owners.set(session, owner);
    }
  }
  return owners;
}
