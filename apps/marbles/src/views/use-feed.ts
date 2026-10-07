import { useCallback, useState } from "react";
import { useAsyncAction } from "~/hooks/use-async-action";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { ALL_WORKSPACES, feedScopes, scopedFeed } from "./feed-model";

export type FeedFocus = "list" | "reader";
export type AnswerHandler = (
  entryId: string,
  answer: FeedAnswer
) => Promise<void>;

/**
 * Answering the selected input entry: number keys pick a choice; without
 * choices, `a` opens a text field. On an approval the number key opens the
 * field for an optional note first; Enter sends the choice with it. The
 * entry flips to answered on the next snapshot, which also closes the field.
 * The dashboard's command table maps the keys onto these.
 */
function useAnswer(entry?: FeedEntrySnapshot, onAnswer?: AnswerHandler) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  /** The approval choice waiting on its note. */
  const [choosing, setChoosing] = useState<string>();
  /** The entry the last answer went to; its progress shows only there. */
  const [target, setTarget] = useState<string>();
  const delivery = useAsyncAction();
  const question =
    onAnswer && entry?.input?.status === "open" ? entry : undefined;
  const choices = question?.input?.choices ?? [];
  const approval = question?.input?.mode === "approval";

  const cancel = useCallback(() => {
    setTyping(false);
    setChoosing(undefined);
    setDraft("");
  }, []);
  const start = useCallback(() => setTyping(true), []);

  const submit = useCallback(
    (answer: FeedAnswer) => {
      const choice = (
        typeof answer === "string" ? answer : answer.choice
      ).trim();
      if (!(question && onAnswer && choice)) {
        return;
      }
      const { id } = question;
      delivery.run(async () => {
        setTarget(id);
        await onAnswer(id, answer);
        cancel();
      });
    },
    [question, onAnswer, delivery.run, cancel]
  );

  /** A choice: sent at once, or held for a note on an approval. */
  const choose = useCallback(
    (choice: string) => {
      if (approval) {
        setChoosing(choice);
        setTyping(true);
        return;
      }
      submit(choice);
    },
    [approval, submit]
  );

  const submitDraft = useCallback(() => {
    const note = draft.trim();
    const answer: FeedAnswer =
      choosing === undefined
        ? draft
        : { choice: choosing, ...(note ? { note } : {}) };
    submit(answer);
  }, [submit, draft, choosing]);

  return {
    cancel,
    choices,
    choose,
    /** Set while an approval choice waits for its optional note. */
    choosing: typing ? choosing : undefined,
    draft,
    error: target === entry?.id ? delivery.error : undefined,
    question,
    sending: delivery.busy && target === question?.id,
    setDraft,
    start,
    submitDraft,
    typing: typing && question !== undefined,
  };
}

export type AnswerState = ReturnType<typeof useAnswer>;

/**
 * Feed tab state: the workspace scope, the selected entry, and whether the
 * list or the reader has the keyboard. The reader's scrollbox handles its
 * own arrow keys while focused.
 */
export function useFeed(
  entries: readonly FeedEntrySnapshot[],
  workspaceId?: string,
  onAnswer?: AnswerHandler
) {
  const [scope, setScope] = useState(ALL_WORKSPACES);
  const [selectedId, setSelectedId] = useState<string>();
  const [focus, setFocus] = useState<FeedFocus>("list");
  const scopes = feedScopes(entries, workspaceId);
  // A workspace can vanish from the store; fall back rather than show nothing.
  const activeScope = scopes.find((item) => item.id === scope) ??
    scopes[0] ?? {
      id: ALL_WORKSPACES,
      label: "All workspaces",
    };
  const visible = scopedFeed(entries, activeScope.id);
  // New entries arrive at the top; keep the reader on what the user chose.
  const selected =
    visible.find((entry) => entry.id === selectedId) ?? visible[0];

  const select = useCallback((entry: FeedEntrySnapshot) => {
    setSelectedId(entry.id);
    setFocus("list");
  }, []);
  const cycleScope = useCallback(() => {
    const index = scopes.findIndex((item) => item.id === activeScope.id);
    const next = scopes[(index + 1) % scopes.length];
    if (next) {
      setScope(next.id);
      setSelectedId(undefined);
    }
  }, [scopes, activeScope.id]);

  const resetScope = useCallback(() => {
    setScope(ALL_WORKSPACES);
    setSelectedId(undefined);
  }, []);

  function move(by: number) {
    const index = selected ? visible.indexOf(selected) : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + by))];
    if (next) {
      setSelectedId(next.id);
    }
  }

  /** The reader takes the keyboard, when there is an entry to read. */
  function read() {
    if (selected) {
      setFocus("reader");
    }
  }

  const answer = useAnswer(selected, onAnswer);

  return {
    answer,
    browse: () => setFocus("list"),
    cycleScope,
    focus,
    move,
    read,
    resetScope,
    scope: activeScope,
    scopeCount: scopes.length,
    select,
    selected,
    total: entries.length,
    visible,
  };
}

export type FeedState = ReturnType<typeof useFeed>;
