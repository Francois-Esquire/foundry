import type { SessionMessage } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";

import { isRecord } from "~/lib/shared/json-data";
import type {
  Reconciled,
  RecordedUsageFact,
  TranscriptTurn,
  TurnSource,
  UsageFact,
  UsageRecords,
} from "~/lib/usage";
import { recoveredFact, sourceOf } from "~/lib/usage";

export interface ReconciledRun {
  readonly active: boolean;
  readonly createdAt: number;
  readonly definition: string;
  readonly endedAt?: number;
  readonly id: string;
  readonly status: string;
}

export type RunRecorded =
  | {
      readonly ledger: Readonly<Record<string, unknown>>;
      readonly session?: string;
    }
  | "unreadable";

export interface SessionStamp {
  readonly id: string;
  readonly stamp: string | null;
}

export interface ListedSessionStore extends SessionStore {
  stamps(): readonly SessionStamp[] | Promise<readonly SessionStamp[]>;
}

export function listsSessions(
  store: SessionStore
): store is ListedSessionStore {
  const listed = store as Partial<ListedSessionStore> | undefined;
  return typeof listed?.stamps === "function";
}

export type SessionListing =
  | (() => readonly SessionStamp[] | Promise<readonly SessionStamp[]>)
  | "unavailable";

export const UNATTRIBUTED = "(unattributed)";

const LEDGER_KEY = /^marbles:(.*)\|(agents\.session|agent\.turn)\|\d+$/;

export function transcriptTurn(
  message: SessionMessage
): TranscriptTurn | undefined {
  const { metadata } = message;
  if (
    message.role !== "assistant" ||
    metadata?.usage === undefined ||
    metadata.timing === undefined ||
    metadata.notification !== undefined
  ) {
    return;
  }
  const { model, timing, usage } = metadata;
  return {
    id: message.id,
    metadata: { ...(model ? { model } : {}), timing, usage },
    sessionId: message.sessionId,
    updatedAt: message.updatedAt,
  };
}

interface OneTurn {
  readonly agent?: string;
  readonly path: readonly string[];
}

export interface LedgerNames {
  readonly sessions: ReadonlySet<string>;
  readonly turns: ReadonlyMap<string, OneTurn>;
}

function stepPath(joined: string, recorded: unknown): readonly string[] {
  if (
    Array.isArray(recorded) &&
    recorded.every(
      (segment): segment is string => typeof segment === "string"
    ) &&
    recorded.join(".") === joined
  ) {
    return recorded;
  }
  return joined === "" || joined.includes(".") ? [] : [joined];
}

export function ledgerNames(
  ledger: Readonly<Record<string, unknown>>
): LedgerNames {
  const sessions = new Set<string>();
  const turns = new Map<string, OneTurn>();
  for (const [key, value] of Object.entries(ledger)) {
    const match = LEDGER_KEY.exec(key);
    if (!(match && isRecord(value))) {
      continue;
    }
    const [, joined = "", kind] = match;
    const sessionId = kind === "agents.session" ? value.id : value.session;
    if (typeof sessionId === "string") {
      sessions.add(sessionId);
    }
    if (kind === "agent.turn" && typeof value.message === "string") {
      turns.set(value.message, {
        ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
        path: stepPath(joined, value.path),
      });
    }
  }
  return { sessions, turns };
}

interface RunEvidence {
  readonly names: LedgerNames;
  readonly run: ReconciledRun;
}

type Transcript = readonly TranscriptTurn[] | null;

interface Unverified {
  readonly runs: Map<string, number>;
  unowned: number;
}

interface Known {
  readonly activeNamed: ReadonlySet<string>;
  readonly markers: ReadonlyMap<string, RecordedUsageFact>;
  readonly named: ReadonlySet<string>;
  readonly turnOwner: ReadonlyMap<
    string,
    OneTurn & { readonly run: ReconciledRun }
  >;
}

export class UsageEvidence {
  readonly #sessions: SessionStore;
  readonly #recordedOf: (runId: string) => Promise<RunRecorded | undefined>;
  readonly #stamps: SessionListing | undefined;
  readonly #runs = new Map<
    string,
    { readonly key: string; readonly recorded: RunRecorded | undefined }
  >();
  readonly #transcripts = new Map<
    string,
    { readonly stamp: string; readonly turns: readonly TranscriptTurn[] }
  >();
  #lastListed: ReadonlySet<string> = new Set();

  constructor(deps: {
    readonly recordedOf: (runId: string) => Promise<RunRecorded | undefined>;
    readonly sessions: SessionStore;
    readonly stamps?: SessionListing;
  }) {
    this.#sessions = deps.sessions;
    this.#recordedOf = deps.recordedOf;
    this.#stamps = deps.stamps;
  }

  async #recorded(run: ReconciledRun): Promise<RunRecorded | undefined> {
    if (run.active) {
      return await this.#recordedOf(run.id);
    }
    const key = `${run.status}:${String(run.endedAt)}`;
    const cached = this.#runs.get(run.id);
    if (cached?.key === key) {
      return cached.recorded;
    }
    const recorded = await this.#recordedOf(run.id);
    if (recorded === "unreadable") {
      this.#runs.delete(run.id);
    } else {
      this.#runs.set(run.id, { key, recorded });
    }
    return recorded;
  }

  async #read(sessionId: string): Promise<Transcript> {
    try {
      if (!(await this.#sessions.getSession(sessionId))) {
        return null;
      }
      const messages = await this.#sessions.listMessages(sessionId);
      return messages.flatMap((message) => {
        const turn = transcriptTurn(message);
        return turn ? [turn] : [];
      });
    } catch {
      return null;
    }
  }

  async #transcript(sessionId: string, stamp?: string): Promise<Transcript> {
    if (stamp === undefined) {
      this.#transcripts.delete(sessionId);
      return await this.#read(sessionId);
    }
    const cached = this.#transcripts.get(sessionId);
    if (cached?.stamp === stamp) {
      return cached.turns;
    }
    const turns = await this.#read(sessionId);
    if (turns) {
      this.#transcripts.set(sessionId, { stamp, turns });
    } else {
      this.#transcripts.delete(sessionId);
    }
    return turns;
  }

  async #readable(
    runs: readonly ReconciledRun[],
    unreadable: Unverified
  ): Promise<RunEvidence[]> {
    const evidence: RunEvidence[] = [];
    for (const run of runs) {
      const recorded = await this.#recorded(run);
      if (recorded === "unreadable" && !run.active) {
        unreadable.runs.set(run.id, (unreadable.runs.get(run.id) ?? 0) + 1);
      }
      if (recorded !== undefined && recorded !== "unreadable") {
        evidence.push({ names: ledgerNames(recorded.ledger), run });
      }
    }
    return evidence;
  }

  async #runsKnown(
    runs: readonly ReconciledRun[],
    named: Set<string>,
    unreadable: Unverified
  ): Promise<Pick<Known, "activeNamed" | "turnOwner">> {
    const activeNamed = new Set<string>();
    const turnOwner = new Map<string, OneTurn & { run: ReconciledRun }>();
    for (const { names, run } of await this.#readable(runs, unreadable)) {
      if (run.active) {
        for (const sessionId of names.sessions) {
          activeNamed.add(sessionId);
        }
        continue;
      }
      for (const sessionId of names.sessions) {
        named.add(sessionId);
      }
      for (const [messageId, turn] of names.turns) {
        turnOwner.set(messageId, { ...turn, run });
      }
    }
    return { activeNamed, turnOwner };
  }

  async #known(
    records: UsageRecords,
    runs: readonly ReconciledRun[],
    unreadable: Unverified
  ): Promise<Known> {
    const named = new Set<string>();
    const markers = new Map<string, RecordedUsageFact>();
    for (const fact of records.facts) {
      if (fact.scope === "unattributed") {
        continue;
      }
      if (fact.lost !== undefined) {
        markers.set(fact.turnId, fact);
      }
      named.add(fact.sessionId);
    }
    return {
      ...(await this.#runsKnown(runs, named, unreadable)),
      markers,
      named,
    };
  }

  #owner(known: Known, turnId: string): TurnSource | undefined {
    const marker = known.markers.get(turnId);
    if (marker) {
      return sourceOf(marker);
    }
    const turn = known.turnOwner.get(turnId);
    if (!turn) {
      return;
    }
    return {
      agentId: turn.agent ?? UNATTRIBUTED,
      run: {
        definition: turn.run.definition,
        path: turn.path,
        runId: turn.run.id,
      },
    };
  }

  async #transcriptOf(
    id: string,
    listed: ReadonlyMap<string, string | null> | undefined
  ): Promise<Transcript> {
    if (listed && !listed.has(id)) {
      return null;
    }
    return await this.#transcript(id, listed?.get(id) ?? undefined);
  }

  async #listed(
    known: Known,
    unreadable: Unverified
  ): Promise<{
    readonly ids: ReadonlySet<string>;
    readonly listed?: ReadonlyMap<string, string | null>;
  }> {
    const named = [...known.named, ...known.activeNamed];
    if (!this.#stamps) {
      return { ids: new Set(named) };
    }
    if (this.#stamps === "unavailable") {
      unreadable.unowned += 1;
      return { ids: new Set(named) };
    }
    let listed: Map<string, string | null>;
    try {
      const stamps = await this.#stamps();
      listed = new Map(stamps.map(({ id, stamp }) => [id, stamp]));
    } catch {
      unreadable.unowned += 1;
      return { ids: new Set([...this.#lastListed, ...named]) };
    }
    this.#lastListed = new Set(listed.keys());
    for (const id of this.#transcripts.keys()) {
      if (!listed.has(id)) {
        this.#transcripts.delete(id);
      }
    }
    return { ids: new Set([...listed.keys(), ...named]), listed };
  }

  async unrecorded(
    records: UsageRecords,
    runs: readonly ReconciledRun[],
    workspaceId: string
  ): Promise<Reconciled> {
    const unreadable: Unverified = { runs: new Map(), unowned: 0 };
    const known = await this.#known(records, runs, unreadable);
    const saved = new Set(
      records.facts
        .filter((fact) => fact.lost === undefined)
        .map((fact) => fact.turnId)
    );
    const { ids, listed } = await this.#listed(known, unreadable);
    const facts = new Map<string, UsageFact>();
    for (const id of ids) {
      const turns = await this.#transcriptOf(id, listed);
      if (!turns) {
        unreadable.unowned += 1;
        continue;
      }
      const unsaved = turns.filter(
        (turn) => !(saved.has(turn.id) || facts.has(turn.id))
      );
      for (const message of unsaved) {
        const source = this.#owner(known, message.id);
        facts.set(
          message.id,
          recoveredFact({
            agentId: UNATTRIBUTED,
            message,
            ...(source ? { source } : {}),
            workspaceId,
          })
        );
      }
    }
    return { facts: [...facts.values()], unreadable };
  }
}
