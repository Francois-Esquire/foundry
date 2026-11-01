import type { SessionMessage, SessionStore } from "@foundry/agents/session";

import { isRecord } from "~/lib/state/json";
import type {
  Reconciled,
  RecordedUsageFact,
  TranscriptTurn,
  TurnSource,
  UsageFact,
  UsageRecords,
} from "~/lib/usage";
import { recoveredFact, sourceOf } from "~/lib/usage";

/**
 * Turns the usage ledger is missing, found in the session transcripts that
 * did survive. Every session the store lists is read (or, for a store that
 * cannot list, every session a fact or a run's file names), so a session
 * none of whose turns saved anything is found too. A committed assistant
 * turn with no saved fact becomes a recovered `lost` leaf: the transcript's
 * tokens and route and an unknown cost. Nothing is written.
 *
 * A recovered leaf is attributed only as far as something durable proves:
 *
 * - a `lost` marker for the turn says where it ran: a run's step, or
 *   outside any run;
 * - a run's file names the turn's message as one of its one-turn calls,
 *   with the agent and step path that call recorded beside it. A record
 *   written before those were kept proves the run, but neither the agent
 *   nor, when its key's joined path holds a `.`, the step.
 *
 * Anything else is `unattributed`, and the totals it may belong to say so.
 * Where a session was opened says nothing about its later turns: any run,
 * or the host, may continue it by its ref. So a session filed under a run's
 * own session, a run's file naming it, and the run's time window prove
 * neither the run nor the step of any one turn; and a session only direct
 * facts name proves no turn direct, since a run this reader cannot load
 * (one still running in another process, or one whose file lost the
 * session's ref) may have continued it. A delegated child's session is no
 * different: its parent's turn reports only its own tokens, never the
 * child's. Every committed turn without a fact or marker is recovered at
 * once, even in a session an active run holds. A run's session reference
 * cannot prove it will record that turn. The ledger is reread before merging,
 * so a fact saved during reconciliation takes precedence over recovery.
 *
 * What cannot be read is counted as unreadable, so the totals it may
 * belong to say they may be incomplete rather than reading as whole. A
 * settled run's file that cannot be read is that run's. A transcript that
 * is missing or cannot be read is owned by nothing: whoever named its
 * session took some of its turns, but for the same reasons any run, or the
 * host, may have taken the rest. A listing that fails counts as one unowned
 * unreadable record too, since any session may be missing from what was
 * read: the sessions records name, and those the last listing held, are
 * still read. A session a running run names and the listing lacks is
 * missing too: a fresh session is filed before a run's file names it. Only
 * one continued by a ref nothing has filed yet reads as missing until its
 * first turn files it. A store that cannot list and outlives the process
 * counts as one too, on every read: a session whose only record was a
 * marker an earlier process held in memory is never found. A settled run's
 * file that could not be read is read again on the next read, so one
 * repaired in place counts at once.
 *
 * Transcripts are read again only when their file's stamp changes, or
 * when the last read failed, and every read sees every committed turn:
 * there is no settling delay. A turn committed a moment before its fact is
 * saved reads as not recorded until that fact is there. Only what recovery
 * reads of each turn is kept between reads, never its parts.
 */

/** A run as reconciliation reads it. */
export interface ReconciledRun {
  /** Queued or running: read its current ledger rather than caching its file. */
  readonly active: boolean;
  readonly createdAt: number;
  readonly definition: string;
  readonly endedAt?: number;
  readonly id: string;
  /** Changes when a parked run resumes, so its file is read again. */
  readonly status: string;
}

/** What a run's scope recorded: its ledger, and the run's own session. */
export type RunRecorded =
  | {
      readonly ledger: Readonly<Record<string, unknown>>;
      readonly session?: string;
    }
  | "unreadable";

/** A session file and a stamp that changes whenever it is written; `null` when the file is there but its stamp cannot be read. */
interface SessionStamp {
  readonly id: string;
  readonly stamp: string | null;
}

/**
 * How sessions are found: by listing the store, or `unavailable` for a store
 * that cannot list them and keeps them past this process.
 */
export type SessionListing = (() => readonly SessionStamp[]) | "unavailable";

/** A recovered leaf's agent when nothing durable names one. */
export const UNATTRIBUTED = "(unattributed)";

const LEDGER_KEY = /^marbles:(.*)\|(agents\.session|agent\.turn)\|\d+$/;

/**
 * A committed model turn, as much of it as recovery reads; nothing for
 * anything else. What `wrapAgentSession` records: approvals and notices
 * carry no usage.
 */
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

/** A one-turn call as its run's file records it. */
interface OneTurn {
  /** Absent in a record written before the agent was kept. */
  readonly agent?: string;
  /** Empty when the record cannot tell which step: the run's, no step's. */
  readonly path: readonly string[];
}

/** What a run's ledger names. */
export interface LedgerNames {
  /** Sessions its steps opened, or took one-turn calls in. */
  readonly sessions: ReadonlySet<string>;
  /** The committed messages of its one-turn calls. */
  readonly turns: ReadonlyMap<string, OneTurn>;
}

/**
 * A one-turn call's step path: the one it recorded, else its key's joined
 * path when no `.` in it can stand for a step name's own.
 */
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

/** Extract session and one-turn message IDs from a run ledger; the last entry naming a message supplies its call. */
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

/** A transcript's committed turns as last read; `null` when it is missing or cannot be read. */
type Transcript = readonly TranscriptTurn[] | null;

/** Evidence that could not be read: a settled run's own file by run, anything else unowned. */
interface Unverified {
  readonly runs: Map<string, number>;
  unowned: number;
}

/** What one read knows: the records, and what the runs' files name. */
interface Known {
  readonly activeNamed: ReadonlySet<string>;
  readonly markers: ReadonlyMap<string, RecordedUsageFact>;
  /** The sessions facts and settled runs' files name. */
  readonly named: ReadonlySet<string>;
  readonly turnOwner: ReadonlyMap<
    string,
    OneTurn & { readonly run: ReconciledRun }
  >;
}

export class UsageEvidence {
  readonly #sessions: SessionStore;
  readonly #recordedOf: (runId: string) => RunRecorded | undefined;
  readonly #stamps: SessionListing | undefined;
  /** A settled run's readable file, read once per run status. */
  readonly #runs = new Map<
    string,
    { readonly key: string; readonly recorded: RunRecorded | undefined }
  >();
  /** Each listed session's turns, as last read whole; read again when its stamp changes. */
  readonly #transcripts = new Map<
    string,
    { readonly stamp: string; readonly turns: readonly TranscriptTurn[] }
  >();
  /** What the last listing held, read again when a listing fails. */
  #lastListed: ReadonlySet<string> = new Set();

  constructor(deps: {
    /** What a run recorded; `undefined` when nothing durable is kept for runs. */
    readonly recordedOf: (runId: string) => RunRecorded | undefined;
    readonly sessions: SessionStore;
    /**
     * Every session file the store holds, when it can list them; absent when
     * it cannot, but keeps its sessions no longer than this process.
     */
    readonly stamps?: SessionListing;
  }) {
    this.#sessions = deps.sessions;
    this.#recordedOf = deps.recordedOf;
    this.#stamps = deps.stamps;
  }

  #recorded(run: ReconciledRun): RunRecorded | undefined {
    if (run.active) {
      return this.#recordedOf(run.id);
    }
    const key = `${run.status}:${String(run.endedAt)}`;
    const cached = this.#runs.get(run.id);
    if (cached?.key === key) {
      return cached.recorded;
    }
    const recorded = this.#recordedOf(run.id);
    // An unreadable file is read again, so one repaired in place counts at once.
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
      // An uncached read supersedes any prior stamped result, even if it fails.
      this.#transcripts.delete(sessionId);
      return await this.#read(sessionId);
    }
    const cached = this.#transcripts.get(sessionId);
    if (cached?.stamp === stamp) {
      return cached.turns;
    }
    const turns = await this.#read(sessionId);
    // A failed read is tried again on the next, even at the same stamp.
    if (turns) {
      this.#transcripts.set(sessionId, { stamp, turns });
    } else {
      this.#transcripts.delete(sessionId);
    }
    return turns;
  }

  /** Each run's file, with what it names; an unreadable settled run's file counted. */
  #readable(
    runs: readonly ReconciledRun[],
    unreadable: Unverified
  ): RunEvidence[] {
    return runs.flatMap((run) => {
      const recorded = this.#recorded(run);
      if (recorded === "unreadable" && !run.active) {
        unreadable.runs.set(run.id, (unreadable.runs.get(run.id) ?? 0) + 1);
      }
      if (recorded === undefined || recorded === "unreadable") {
        return [];
      }
      return [
        {
          names: ledgerNames(recorded.ledger),
          run,
        },
      ];
    });
  }

  /** What the runs' files name: settled runs' sessions and one-turn calls, and what running runs hold. */
  #runsKnown(
    runs: readonly ReconciledRun[],
    named: Set<string>,
    unreadable: Unverified
  ): Pick<Known, "activeNamed" | "turnOwner"> {
    const activeNamed = new Set<string>();
    const turnOwner = new Map<string, OneTurn & { run: ReconciledRun }>();
    for (const { names, run } of this.#readable(runs, unreadable)) {
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

  /** What the records and runs' files say, before any transcript is read. */
  #known(
    records: UsageRecords,
    runs: readonly ReconciledRun[],
    unreadable: Unverified
  ): Known {
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
      ...this.#runsKnown(runs, named, unreadable),
      markers,
      named,
    };
  }

  /** Where a turn ran, as far as its own marker or one-turn record proves; none is `unattributed`. */
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

  /** A session's transcript; a listing that does not hold it means it is missing, and one without its stamp reads it uncached. */
  async #transcriptOf(
    id: string,
    listed: ReadonlyMap<string, string | null> | undefined
  ): Promise<Transcript> {
    if (listed && !listed.has(id)) {
      return null;
    }
    return await this.#transcript(id, listed?.get(id) ?? undefined);
  }

  /**
   * Every listed session, and every one a fact or run names. A listing that
   * fails is counted as unreadable and owned by nothing, and the sessions
   * the last one held are read again beside the named ones.
   */
  #listed(
    known: Known,
    unreadable: Unverified
  ): {
    readonly ids: ReadonlySet<string>;
    readonly listed?: ReadonlyMap<string, string | null>;
  } {
    const named = [...known.named, ...known.activeNamed];
    if (!this.#stamps) {
      return { ids: new Set(named) };
    }
    if (this.#stamps === "unavailable") {
      // A session whose only record an earlier process lost is never found.
      unreadable.unowned += 1;
      return { ids: new Set(named) };
    }
    let listed: Map<string, string | null>;
    try {
      listed = new Map(this.#stamps().map(({ id, stamp }) => [id, stamp]));
    } catch {
      // State is advisory: what was not listed may still be there.
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

  /** Recovered leaves for turns the transcripts show and `records` lacks, and the evidence that could not be read. */
  async unrecorded(
    records: UsageRecords,
    runs: readonly ReconciledRun[],
    workspaceId: string
  ): Promise<Reconciled> {
    const unreadable: Unverified = { runs: new Map(), unowned: 0 };
    const known = this.#known(records, runs, unreadable);
    const saved = new Set(
      records.facts
        .filter((fact) => fact.lost === undefined)
        .map((fact) => fact.turnId)
    );
    const { ids, listed } = this.#listed(known, unreadable);
    const facts = new Map<string, UsageFact>();
    for (const id of ids) {
      const turns = await this.#transcriptOf(id, listed);
      if (!turns) {
        // Naming a session proves nothing about who took the turns it lost.
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
