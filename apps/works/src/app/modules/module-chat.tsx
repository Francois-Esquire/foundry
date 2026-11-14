import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "~/app/components/button";
import { Input } from "~/app/components/input";
import type {
  AuthoringAnswer,
  AuthoringItem,
  AuthoringProposalView,
  AuthoringToolStatus,
  AuthoringTurnView,
} from "~/shared/authoring";
import { isSettledTurn } from "~/shared/authoring";
import type { ModuleChat } from "./use-module-chat";

const TOOL_STATUS: Record<AuthoringToolStatus, string> = {
  cancelled: "stopped",
  complete: "done",
  denied: "denied",
  failed: "failed",
  running: "running…",
};

function turnStatus(turn: AuthoringTurnView) {
  switch (turn.status) {
    case "queued":
      return "Waiting for the previous request to finish…";
    case "running":
      return turn.waiting
        ? "Waiting for a sandbox. Turn off another Module to free one."
        : "Working…";
    case "failed":
      return turn.error ?? "The request failed.";
    case "cancelled":
      return turn.error ?? "Cancelled.";
    case "interrupted":
      return turn.error ?? "Interrupted.";
    default:
      return turn.proposal ? "" : "Finished without changing source files.";
  }
}

function QuestionForm({
  item,
  onAnswer,
}: {
  item: Extract<AuthoringItem, { kind: "question" }>;
  onAnswer: (inputId: string, answer: AuthoringAnswer) => void;
}) {
  const formId = useId();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  /**
   * Options and text fields name their question in `data-question`. A
   * checkbox adds or removes its option; a radio or a text field is the
   * whole answer.
   */
  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const {
      checked,
      dataset: { question },
      type,
      value,
    } = event.currentTarget;
    if (!question) {
      return;
    }
    setAnswers((current) => {
      const previous = current[question] ?? [];
      if (type === "checkbox") {
        return {
          ...current,
          [question]: checked
            ? [...previous, value]
            : previous.filter((entry) => entry !== value),
        };
      }
      return { ...current, [question]: value ? [value] : [] };
    });
  }, []);
  const complete = item.questions.every(
    (question) => (answers[question.id]?.length ?? 0) > 0
  );
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (complete) {
        onAnswer(item.id, { answers, kind: "answer" });
      }
    },
    [answers, complete, item.id, onAnswer]
  );
  const decline = useCallback(
    () => onAnswer(item.id, { kind: "decline" }),
    [item.id, onAnswer]
  );
  return (
    <form
      aria-label="Agent question"
      className="flex flex-col gap-3 rounded-xl border border-border/60 p-3"
      onSubmit={submit}
    >
      {item.questions.map((question) => (
        <fieldset className="flex flex-col gap-1.5" key={question.id}>
          <legend className="mb-1 font-medium text-xs">
            {question.header ? `${question.header}: ` : ""}
            {question.question}
          </legend>
          {question.options ? (
            question.options.map((option) => (
              <label
                className="flex items-start gap-2 text-xs"
                key={option.label}
              >
                <input
                  checked={
                    answers[question.id]?.includes(option.label) ?? false
                  }
                  data-question={question.id}
                  name={`${formId}-${question.id}`}
                  onChange={change}
                  type={question.multiSelect ? "checkbox" : "radio"}
                  value={option.label}
                />
                <span>
                  {option.label}
                  {option.description && (
                    <span className="block text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            ))
          ) : (
            <Input
              aria-label={question.question}
              className="h-8 text-xs"
              data-question={question.id}
              onChange={change}
              value={answers[question.id]?.[0] ?? ""}
            />
          )}
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button disabled={!complete} size="xs" type="submit">
          Answer
        </Button>
        <Button onClick={decline} size="xs" variant="ghost">
          Decline
        </Button>
      </div>
    </form>
  );
}

const INPUT_STATUS = {
  answered: "Answered.",
  cancelled: "No longer waiting: the request ended.",
  declined: "Declined.",
  interrupted: "Not answered: Works closed while the agent waited.",
  open: "",
} as const;

function ApprovalRequest({
  item,
  onAnswer,
}: {
  item: Extract<AuthoringItem, { kind: "approval" }>;
  onAnswer: (inputId: string, answer: AuthoringAnswer) => void;
}) {
  const allow = useCallback(
    () => onAnswer(item.id, { approved: true, kind: "approval" }),
    [item.id, onAnswer]
  );
  const deny = useCallback(
    () => onAnswer(item.id, { approved: false, kind: "approval" }),
    [item.id, onAnswer]
  );
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-3 text-xs">
      <p>
        The agent asks to use <span className="font-mono">{item.toolName}</span>
        {item.summary ? ` (${item.summary})` : ""}.
      </p>
      {item.status === "open" ? (
        <div className="flex gap-2">
          <Button onClick={allow} size="xs">
            Allow once
          </Button>
          <Button onClick={deny} size="xs" variant="ghost">
            Deny
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">{INPUT_STATUS[item.status]}</p>
      )}
    </div>
  );
}

function ChatItem({
  item,
  onAnswer,
}: {
  item: AuthoringItem;
  onAnswer: (inputId: string, answer: AuthoringAnswer) => void;
}) {
  if (item.kind === "text") {
    return <p className="whitespace-pre-wrap text-xs">{item.text}</p>;
  }
  if (item.kind === "tool") {
    return (
      <p className="font-mono text-[0.6875rem] text-muted-foreground">
        {item.name} · {TOOL_STATUS[item.status]}
        {item.status === "denied" && item.reason ? ` (${item.reason})` : ""}
      </p>
    );
  }
  if (item.kind === "approval") {
    return <ApprovalRequest item={item} onAnswer={onAnswer} />;
  }
  if (item.status === "open") {
    return <QuestionForm item={item} onAnswer={onAnswer} />;
  }
  return (
    <div className="text-xs">
      {item.questions.map((question) => (
        <p key={question.id}>{question.question}</p>
      ))}
      <p className="text-muted-foreground">{INPUT_STATUS[item.status]}</p>
    </div>
  );
}

function ProposalCard({
  chat,
  onReview,
  proposal,
  turnId,
}: {
  chat: ModuleChat;
  onReview: (turnId: string) => void;
  proposal: AuthoringProposalView;
  turnId: string;
}) {
  const { accept, dismiss, resolveByHand } = chat;
  const review = useCallback(() => onReview(turnId), [onReview, turnId]);
  const accepted = useCallback(() => accept(turnId), [accept, turnId]);
  const byHand = useCallback(
    () => resolveByHand(turnId),
    [resolveByHand, turnId]
  );
  const dismissed = useCallback(() => dismiss(turnId), [dismiss, turnId]);
  const stale = chat.stale[turnId];
  const count = proposal.paths.length;
  return (
    <section
      aria-label="Proposed changes"
      className="flex flex-col gap-2 rounded-xl border border-border/60 p-3 text-xs"
    >
      <p className="font-medium">
        Proposed changes to {count} {count === 1 ? "file" : "files"}
      </p>
      <ul className="font-mono text-[0.6875rem] text-muted-foreground">
        {proposal.paths.map((path) => (
          <li className="truncate" key={path}>
            {path}
          </li>
        ))}
      </ul>
      {proposal.status === "applied" && (
        <p className="text-muted-foreground">Applied to your draft.</p>
      )}
      {proposal.status === "dismissed" && (
        <p className="text-muted-foreground">Dismissed.</p>
      )}
      {proposal.status === "pending" && stale && (
        <p className="text-destructive" role="alert">
          {stale}
        </p>
      )}
      {proposal.status === "pending" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={review} size="xs" variant="outline">
            {stale ? "Compare" : "Review"}
          </Button>
          {stale ? (
            <Button onClick={byHand} size="xs">
              Resolve by hand
            </Button>
          ) : (
            <Button onClick={accepted} size="xs">
              Accept
            </Button>
          )}
          <Button onClick={dismissed} size="xs" variant="ghost">
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}

function ChatTurn({
  chat,
  onReview,
  turn,
}: {
  chat: ModuleChat;
  onReview: (turnId: string) => void;
  turn: AuthoringTurnView;
}) {
  const { answer, cancel } = chat;
  const answered = useCallback(
    (inputId: string, value: AuthoringAnswer) =>
      answer(turn.id, inputId, value),
    [answer, turn.id]
  );
  const cancelled = useCallback(() => cancel(turn.id), [cancel, turn.id]);
  const status = turnStatus(turn);
  const live = !isSettledTurn(turn.status);
  // Items only ever append, and text items have no id of their own.
  let texts = 0;
  return (
    <article aria-label="Request" className="flex flex-col gap-2">
      <p className="ml-6 whitespace-pre-wrap rounded-xl bg-muted px-3 py-2 text-xs">
        {turn.prompt}
      </p>
      {turn.notice && (
        <p className="text-muted-foreground text-xs">{turn.notice}</p>
      )}
      {turn.items.map((item) => {
        if (item.kind === "text") {
          texts += 1;
        }
        return (
          <ChatItem
            item={item}
            key={
              item.kind === "text" ? `text:${texts}` : `${item.kind}:${item.id}`
            }
            onAnswer={answered}
          />
        );
      })}
      {status && (
        <p
          className={
            turn.status === "failed"
              ? "text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
        >
          {status}
        </p>
      )}
      {live && (
        <Button
          className="self-start"
          onClick={cancelled}
          size="xs"
          variant="outline"
        >
          Cancel request
        </Button>
      )}
      {turn.proposal && (
        <ProposalCard
          chat={chat}
          onReview={onReview}
          proposal={turn.proposal}
          turnId={turn.id}
        />
      )}
    </article>
  );
}

export function ModuleChatPanel({
  chat,
  disabled,
  onReview,
  onSend,
}: {
  chat: ModuleChat;
  disabled: boolean;
  onReview: (turnId: string) => void;
  /** Send with the Draft as it is now; resolves whether it was sent. */
  onSend: (prompt: string) => Promise<boolean>;
}) {
  const [message, setMessage] = useState("");
  const turns = chat.conversation?.turns ?? [];
  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const prompt = message.trim();
      if (!prompt || chat.sending) {
        return;
      }
      if (await onSend(prompt)) {
        setMessage("");
      }
    },
    [chat.sending, message, onSend]
  );
  const type = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      setMessage(event.currentTarget.value),
    []
  );
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit().catch(() => undefined);
      }
    },
    [submit]
  );
  return (
    <aside
      aria-label="Module chat"
      className="flex min-h-0 w-80 shrink-0 flex-col border-border/40 border-l"
    >
      <h2 className="flex h-11 shrink-0 items-center px-4 font-medium text-[0.6875rem] text-muted-foreground/70 uppercase tracking-[0.12em]">
        Chat
      </h2>
      <div
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-4"
        role="log"
      >
        {chat.conversation === null && !chat.error && (
          <p className="text-muted-foreground text-xs">Loading chat…</p>
        )}
        {chat.conversation !== null && turns.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Ask for a change to this module. The agent works on a copy of your
            draft, and its edits wait for your review.
          </p>
        )}
        {turns.map((turn) => (
          <ChatTurn chat={chat} key={turn.id} onReview={onReview} turn={turn} />
        ))}
      </div>
      {chat.status && (
        <p
          aria-live="polite"
          className="shrink-0 px-4 pb-2 text-xs"
          role="status"
        >
          {chat.status}
        </p>
      )}
      {chat.error && (
        <p className="shrink-0 px-4 pb-2 text-destructive text-xs" role="alert">
          {chat.error}
        </p>
      )}
      <form className="flex shrink-0 flex-col gap-2 p-3" onSubmit={submit}>
        <label className="text-muted-foreground text-xs" htmlFor="chat-message">
          Message
        </label>
        <textarea
          className="min-h-20 w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
          disabled={disabled}
          id="chat-message"
          onChange={type}
          onKeyDown={keyDown}
          placeholder="Describe a change. Shift+Enter for a new line."
          value={message}
        />
        <Button
          className="self-end"
          disabled={disabled || chat.sending || !message.trim()}
          size="sm"
          type="submit"
        >
          Send
        </Button>
      </form>
    </aside>
  );
}
