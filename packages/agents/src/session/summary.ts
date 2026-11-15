import type { Summary } from "../schema";
import type { Summarizer } from "./compactor";
import type { SessionStore } from "./store";
import type { SessionMessage } from "./types";

export type { Summary } from "../schema";

/** Session-keyed rolling store of digests. */
export interface SummaryStore {
  get(subjectSessionId: string): Summary | undefined;
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

export interface SummarizeSessionDeps {
  store: SessionStore;
  summaries: SummaryStore;
  summarizer: Summarizer;
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
