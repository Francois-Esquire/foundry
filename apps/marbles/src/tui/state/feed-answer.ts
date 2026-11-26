import type {
  AnswerChoice,
  AnswerDelivery,
  AnswerView,
} from "~/components/blocks/feed-reader";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { AnswerState } from "./use-feed";

type FeedInput = NonNullable<FeedEntrySnapshot["input"]>;

export type InputState = "answered" | "cancelled" | "pending";

export function inputState(input: FeedEntrySnapshot["input"]): InputState {
  if (input?.status === "open") {
    return "pending";
  }
  return input?.status === "cancelled" ? "cancelled" : "answered";
}

function answerChoices(choices: readonly string[]): AnswerChoice[] {
  return choices.map((choice, index) => ({
    id: `answer:${index + 1}`,
    label: `${index + 1} ${choice}`,
    value: choice,
  }));
}

function answerShortcut(count: number): string {
  return ` ${count === 1 ? "1" : `1-${count}`} answer `;
}

function delivery(answer: AnswerState): AnswerDelivery {
  return {
    sending: answer.sending,
    ...(answer.error ? { error: answer.error } : {}),
  };
}

function openAnswer(
  input: FeedInput,
  answer: AnswerState,
  focused: boolean
): AnswerView {
  const status = delivery(answer);
  if (answer.typing) {
    return {
      ...status,
      draft: answer.draft,
      focused,
      hint: answer.choosing
        ? "note optional · Enter send · Esc cancel"
        : "Enter send · Esc cancel",
      kind: "typing",
      onInput: answer.setDraft,
      onSubmit: answer.submitDraft,
      prompt: answer.choosing ? `${answer.choosing} · note › ` : "› ",
    };
  }
  if (answer.question === undefined) {
    return {
      ...status,
      choices: answerChoices(input.choices),
      kind: "unavailable",
    };
  }
  if (input.choices.length === 0) {
    return { ...status, kind: "free-text" };
  }
  return {
    ...status,
    choices: answerChoices(input.choices),
    kind: "choice",
    onChoose: answer.choose,
    shortcut: answerShortcut(input.choices.length),
  };
}

export function answerView(
  input: FeedEntrySnapshot["input"],
  answer: AnswerState,
  focused = true
): AnswerView | undefined {
  if (!input) {
    return undefined;
  }
  const state = inputState(input);
  if (state === "answered") {
    return {
      answer: input.answer ?? "",
      kind: "answered",
      ...(input.note ? { note: input.note } : {}),
    };
  }
  if (state === "cancelled") {
    return { kind: "cancelled" };
  }
  return openAnswer(input, answer, focused);
}
