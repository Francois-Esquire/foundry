import { useCallback, useEffect, useState } from "react";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { useAsyncAction } from "~/tui/hooks/use-async-action";
import { inputState } from "./feed-answer";
import { ALL_WORKSPACES, feedKey, feedScopes, scopedFeed } from "./feed-model";

export type FeedFocus = "list" | "reader";
export type AnswerHandler = (
  entryId: string,
  answer: FeedAnswer
) => Promise<void>;

interface Answering {
  readonly choosing?: string;
  readonly draft: string;
  readonly key: string;
}

function useAnswer(
  entry: FeedEntrySnapshot | undefined,
  onAnswer: AnswerHandler | undefined,
  pin: (entry: FeedEntrySnapshot) => void
) {
  const [answering, setAnswering] = useState<Answering>();
  const [target, setTarget] = useState<string>();
  const delivery = useAsyncAction();
  const question =
    onAnswer && entry && inputState(entry.input) === "pending"
      ? entry
      : undefined;
  const questionKey = question && feedKey(question);
  const current = answering?.key === questionKey ? answering : undefined;
  const choices = question?.input?.choices ?? [];
  const approval = question?.input?.mode === "approval";

  useEffect(() => {
    if (answering !== undefined && answering.key !== questionKey) {
      setAnswering(undefined);
    }
  }, [answering, questionKey]);

  const cancel = useCallback(() => setAnswering(undefined), []);
  const start = useCallback(() => {
    if (question) {
      pin(question);
      setAnswering({ draft: "", key: feedKey(question) });
    }
  }, [question, pin]);
  const setDraft = useCallback(
    (draft: string) =>
      setAnswering((previous) => previous && { ...previous, draft }),
    []
  );

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
        setAnswering((previous) =>
          previous?.key === key ? undefined : previous
        );
      });
    },
    [question, onAnswer, delivery.run]
  );

  const choose = useCallback(
    (choice: string) => {
      if (approval && question) {
        pin(question);
        setAnswering({ choosing: choice, draft: "", key: feedKey(question) });
        return;
      }
      submit(choice);
    },
    [approval, question, pin, submit]
  );

  const submitDraft = useCallback(() => {
    if (current === undefined) {
      return;
    }
    const note = current.draft.trim();
    const answer: FeedAnswer =
      current.choosing === undefined
        ? current.draft
        : { choice: current.choosing, ...(note ? { note } : {}) };
    submit(answer);
  }, [submit, current]);

  return {
    cancel,
    choices,
    choose,
    choosing: current?.choosing,
    draft: current?.draft ?? "",
    error:
      entry !== undefined && target === feedKey(entry)
        ? delivery.error
        : undefined,
    question,
    sending: delivery.busy && question !== undefined && target === questionKey,
    setDraft,
    start,
    submitDraft,
    typing: current !== undefined,
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
  const pin = useCallback(
    (entry: FeedEntrySnapshot) => setSelectedKey(feedKey(entry)),
    []
  );
  const answer = useAnswer(answerable, onAnswer, pin);

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
