import { describe, expect, test } from "vitest";

import type { Summarizer } from "../../session/compactor";
import { InMemorySessionStore } from "../../session/store";
import { createSummaryStore, summarizeSession } from "../../session/summary";
import type { SessionPart, SessionRole } from "../../session/types";

const text = (t: string): SessionPart[] => [{ text: t, type: "text" }];

async function seedRoles(
  store: InMemorySessionStore,
  sessionId: string,
  items: [SessionRole, string][]
): Promise<void> {
  await store.createSession({ id: sessionId });
  for (const [role, label] of items) {
    await store.appendMessage({ parts: text(label), role, sessionId });
  }
}

describe("summarizeSession", () => {
  test("reads the subject session, summarizes it, and upserts the digest", async () => {
    const store = new InMemorySessionStore();
    await seedRoles(store, "subj-1", [
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    const summarizer: Summarizer = {
      summarize: () => Promise.resolve("DIGEST v1"),
    };
    const summaries = createSummaryStore();

    const s1 = await summarizeSession(
      { id: "subj-1" },
      { store, summaries, summarizer }
    );

    expect(s1).toEqual({ digestText: "DIGEST v1", subjectSessionId: "subj-1" });
    expect(summaries.get("subj-1")).toEqual(s1);
  });

  test("rolling overwrite: a later summarization replaces the prior digest in place", async () => {
    const store = new InMemorySessionStore();
    await seedRoles(store, "subj-1", [
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    const summaries = createSummaryStore();

    await summarizeSession(
      { id: "subj-1" },
      {
        store,
        summaries,
        summarizer: { summarize: () => Promise.resolve("DIGEST v1") },
      }
    );
    await summarizeSession(
      { id: "subj-1" },
      {
        store,
        summaries,
        summarizer: { summarize: () => Promise.resolve("DIGEST v2") },
      }
    );

    expect(summaries.get("subj-1")?.digestText).toBe("DIGEST v2");
  });

  test("disjointness: the produced Summary carries exactly subjectSessionId + digestText", async () => {
    const store = new InMemorySessionStore();
    await seedRoles(store, "subj-1", [["user", "hi"]]);
    const summarizer: Summarizer = {
      summarize: () => Promise.resolve("DIGEST v1"),
    };
    const summaries = createSummaryStore();

    const s1 = await summarizeSession(
      { id: "subj-1" },
      { store, summaries, summarizer }
    );

    expect(Object.keys(s1).sort()).toEqual(["digestText", "subjectSessionId"]);
  });
});
