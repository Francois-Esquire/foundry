import type { KeyEvent } from "@opentui/core";
import { useCallback, useState } from "react";
import type { FeedAnswer } from "~/feed/entry";
import type { FeedEntrySnapshot } from "./dashboard-model";
import { ALL_WORKSPACES, feedScopes, scopedFeed } from "./feed-model";

export type FeedFocus = "list" | "reader";
export type AnswerHandler = (
  entryId: string,
  answer: FeedAnswer
) => Promise<void>;
const CHOICE_KEY = /^[1-9]$/;

/**
 * Answering the selected input entry: number keys pick a choice; without
 * choices, `a` opens a text field. On an approval the number key opens the
 * field for an optional note first; Enter sends the choice with it. The
 * entry flips to answered on the next snapshot, which also closes the field.
 */
function useAnswer(entry?: FeedEntrySnapshot, onAnswer?: AnswerHandler) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  /** The approval choice waiting on its note. */
  const [choosing, setChoosing] = useState<string>();
  const [sending, setSending] = useState<string>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const question =
    onAnswer && entry?.input?.status === "open" ? entry : undefined;
  const choices = question?.input?.choices ?? [];
  const approval = question?.input?.mode === "approval";

  const submit = useCallback(
    async (answer: FeedAnswer) => {
      const choice = (
        typeof answer === "string" ? answer : answer.choice
      ).trim();
      if (!(question && onAnswer && choice) || sending) {
        return;
      }
      setSending(question.id);
      setFailure(undefined);
      try {
        await onAnswer(question.id, answer);
        setTyping(false);
        setChoosing(undefined);
        setDraft("");
      } catch (error) {
        setFailure({
          id: question.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setSending(undefined);
      }
    },
    [question, onAnswer, sending]
  );

  /** A choice: sent at once, or held for a note on an approval. */
  const choose = useCallback(
    (choice: string) => {
      if (approval) {
        setChoosing(choice);
        setTyping(true);
        return;
      }
      submit(choice).catch(() => undefined);
    },
    [approval, submit]
  );

  const submitDraft = useCallback(() => {
    const note = draft.trim();
    const answer: FeedAnswer =
      choosing === undefined
        ? draft
        : { choice: choosing, ...(note ? { note } : {}) };
    submit(answer).catch(() => undefined);
  }, [submit, draft, choosing]);

  function handleKey(key: KeyEvent): boolean {
    if (!question) {
      return false;
    }
    if (typing) {
      // The text field has the keys; only Esc belongs to the feed.
      if (key.name === "escape") {
        setTyping(false);
        setChoosing(undefined);
        setDraft("");
      }
      return true;
    }
    if (choices.length > 0 && CHOICE_KEY.test(key.sequence)) {
      const choice = choices[Number(key.sequence) - 1];
      if (choice !== undefined) {
        choose(choice);
      }
      return true;
    }
    if (choices.length === 0 && key.name === "a") {
      setTyping(true);
      return true;
    }
    return false;
  }

  return {
    choose,
    /** Set while an approval choice waits for its optional note. */
    choosing: typing ? choosing : undefined,
    draft,
    error: failure?.id === entry?.id ? failure?.message : undefined,
    handleKey,
    question,
    sending: sending !== undefined && sending === question?.id,
    setDraft,
    submit,
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

  function move(direction: number) {
    const index = selected ? visible.indexOf(selected) : -1;
    const next =
      visible[Math.max(0, Math.min(visible.length - 1, index + direction))];
    if (next) {
      setSelectedId(next.id);
    }
  }

  const answer = useAnswer(selected, onAnswer);

  /** Returns true when the key belonged to the feed. */
  function handleKey(key: KeyEvent): boolean {
    if (answer.handleKey(key)) {
      return true;
    }
    if (key.name === "w") {
      cycleScope();
      return true;
    }
    if (key.name === "x") {
      resetScope();
      return true;
    }
    if (focus === "reader") {
      if (key.name === "escape" || key.name === "left" || key.name === "tab") {
        setFocus("list");
        return true;
      }
      return false;
    }
    switch (key.name) {
      case "up":
      case "k":
        move(-1);
        return true;
      case "down":
      case "j":
        move(1);
        return true;
      case "return":
      case "enter":
      case "right":
      case "tab":
        if (selected) {
          setFocus("reader");
        }
        return true;
      default:
        return false;
    }
  }

  return {
    answer,
    cycleScope,
    focus,
    handleKey,
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
