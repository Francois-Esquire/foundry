import { useCallback, useState } from "react";
import { useAsyncAction } from "~/cli/hooks/use-async-action";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { inputState } from "./feed-answer";
import { ALL_WORKSPACES, feedKey, feedScopes, scopedFeed } from "./feed-model";

export type FeedFocus = "list" | "reader";
export type AnswerHandler = (
  entryId: string,
  answer: FeedAnswer
) => Promise<void>;

function useAnswer(entry?: FeedEntrySnapshot, onAnswer?: AnswerHandler) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [choosing, setChoosing] = useState<string>();
  const [target, setTarget] = useState<string>();
  const delivery = useAsyncAction();
  const question =
    onAnswer && entry && inputState(entry.input) === "pending"
      ? entry
      : undefined;
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
      const key = feedKey(question);
      delivery.run(async () => {
        setTarget(key);
        await onAnswer(id, answer);
        cancel();
      });
    },
    [question, onAnswer, delivery.run, cancel]
  );

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
    choosing: typing ? choosing : undefined,
    draft,
    error:
      entry !== undefined && target === feedKey(entry)
        ? delivery.error
        : undefined,
    question,
    sending:
      delivery.busy && question !== undefined && target === feedKey(question),
    setDraft,
    start,
    submitDraft,
    typing: typing && question !== undefined,
  };
}

export type AnswerState = ReturnType<typeof useAnswer>;

export function useFeed(
  entries: readonly FeedEntrySnapshot[],
  workspaceId?: string,
  onAnswer?: AnswerHandler,
  initialScope = ALL_WORKSPACES
) {
  const [scope, setScope] = useState(initialScope);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [focus, setFocus] = useState<FeedFocus>("list");
  const scopes = feedScopes(entries, workspaceId);
  const activeScope = scopes.find((item) => item.id === scope) ??
    scopes[0] ?? {
      id: ALL_WORKSPACES,
      label: "All workspaces",
    };
  const visible = scopedFeed(entries, activeScope.id);
  const selected =
    visible.find((entry) => feedKey(entry) === selectedKey) ?? visible[0];

  const select = useCallback((entry: FeedEntrySnapshot) => {
    setSelectedKey(feedKey(entry));
    setFocus("list");
  }, []);
  const cycleScope = useCallback(() => {
    const index = scopes.findIndex((item) => item.id === activeScope.id);
    const next = scopes[(index + 1) % scopes.length];
    if (next) {
      setScope(next.id);
      setSelectedKey(undefined);
    }
  }, [scopes, activeScope.id]);

  const resetScope = useCallback(() => {
    setScope(ALL_WORKSPACES);
    setSelectedKey(undefined);
  }, []);

  function move(by: number) {
    const index = selected ? visible.indexOf(selected) : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + by))];
    if (next) {
      setSelectedKey(feedKey(next));
    }
  }

  function open(entryId: string) {
    const entry = entries.find(
      (item) =>
        item.id === entryId &&
        (workspaceId === undefined || item.workspace.id === workspaceId)
    );
    if (!entry) {
      return;
    }
    if (!visible.includes(entry)) {
      setScope(ALL_WORKSPACES);
    }
    setSelectedKey(feedKey(entry));
    setFocus("reader");
  }

  function read() {
    if (selected) {
      setFocus("reader");
    }
  }

  const answerable =
    workspaceId === undefined || selected?.workspace.id === workspaceId
      ? selected
      : undefined;
  const answer = useAnswer(answerable, onAnswer);

  return {
    answer,
    browse: () => setFocus("list"),
    cycleScope,
    focus,
    move,
    open,
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
