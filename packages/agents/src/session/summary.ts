import type { Summarizer } from "./compactor";
import type { SessionStore } from "./store";
import type { SessionMessage } from "./types";

/** A cross-session digest. Subject = exactly one session; digest-shaped, NOT a fact-memory. */
export interface Summary {
  digestText: string;
  subjectSessionId: string;
}

/** Process-lifetime, session-keyed, rolling store. Persistence deferred (matches the scheduler's
 *  in-memory design, ruling 0008 R3). Holds NO embedding (ruling 0005). */
export interface SummaryStore {
  get(subjectSessionId: string): Summary | undefined;
  /** Rolling: overwrites the subject session's prior digest in place. */
  upsert(summary: Summary): void;
}

/** In-memory `Map<SessionId, Summary>` implementation. */
export function createSummaryStore(): SummaryStore {
  const byId = new Map<string, Summary>();
  return {
    get(subjectSessionId) {
      return byId.get(subjectSessionId);
    },
    upsert(summary) {
      byId.set(summary.subjectSessionId, summary);
    },
  };
}

/** Injected seams: the SessionStore to READ the subject transcript, the reused Summarizer, and the
 *  rolling SummaryStore to upsert into. */
export interface SummarizeSessionDeps {
  store: SessionStore; // read-only here — the compaction floor is untouched
  summaries: SummaryStore; // rolling upsert destination
  summarizer: Summarizer; // reused createModelSummarizer output (or a stub in tests)
}

export async function summarizeSession(
  session: { id: string },
  deps: SummarizeSessionDeps
): Promise<Summary> {
  const messages: SessionMessage[] = await deps.store.listMessages(session.id);
  const digestText = await deps.summarizer.summarize(messages);
  const summary: Summary = { digestText, subjectSessionId: session.id };
  deps.summaries.upsert(summary);
  return summary;
}
