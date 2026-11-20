import { describe, expect, it } from "vitest";
import { answerView, inputState } from "~/cli/state/feed-answer";
import type { AnswerState } from "~/cli/state/use-feed";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

const [question] = dashboardSnapshot.feed;
const choose: AnswerState["choose"] = () => undefined;
const setDraft: AnswerState["setDraft"] = () => undefined;
const submitDraft = () => undefined;

function answerState(overrides: Partial<AnswerState> = {}): AnswerState {
  return {
    cancel: () => undefined,
    choices: [],
    choose,
    choosing: undefined,
    draft: "",
    error: undefined,
    question,
    sending: false,
    setDraft,
    start: () => undefined,
    submitDraft,
    typing: false,
    ...overrides,
  };
}

function open(choices: readonly string[]): FeedEntrySnapshot["input"] {
  return { choices, status: "open" };
}

describe("answerView", () => {
  it("has nothing to show for an entry without input", () => {
    expect(answerView(undefined, answerState())).toBeUndefined();
  });

  it("shows a recorded answer and its note, or a cancelled question", () => {
    expect(
      answerView(
        {
          answer: "merge",
          choices: [],
          note: "looks good",
          status: "answered",
        },
        answerState()
      )
    ).toEqual({ answer: "merge", kind: "answered", note: "looks good" });
    expect(
      answerView({ choices: [], status: "answered" }, answerState())
    ).toEqual({ answer: "", kind: "answered" });
    expect(
      answerView({ choices: ["merge"], status: "cancelled" }, answerState())
    ).toEqual({ kind: "cancelled" });
  });

  it("offers numbered choices with their shortcut when this dashboard can answer", () => {
    expect(answerView(open(["merge", "hold"]), answerState())).toEqual({
      choices: [
        { id: "answer:1", label: "1 merge", value: "merge" },
        { id: "answer:2", label: "2 hold", value: "hold" },
      ],
      kind: "choice",
      onChoose: choose,
      sending: false,
      shortcut: " 1-2 answer ",
    });
    expect(answerView(open(["merge"]), answerState())).toMatchObject({
      shortcut: " 1 answer ",
    });
  });

  it("invites a typed answer when there are no choices", () => {
    expect(answerView(open([]), answerState({ sending: true }))).toEqual({
      kind: "free-text",
      sending: true,
    });
  });

  it("shows the choices as unavailable when another dashboard must answer", () => {
    expect(
      answerView(open(["merge"]), answerState({ question: undefined }))
    ).toEqual({
      choices: [{ id: "answer:1", label: "1 merge", value: "merge" }],
      kind: "unavailable",
      sending: false,
    });
    expect(
      answerView(open([]), answerState({ question: undefined }))
    ).toMatchObject({ choices: [], kind: "unavailable" });
  });

  it("types an answer, or a note for a chosen approval", () => {
    expect(
      answerView(
        open(["merge"]),
        answerState({ draft: "hi", error: "failed", typing: true })
      )
    ).toEqual({
      draft: "hi",
      error: "failed",
      hint: "Enter send · Esc cancel",
      kind: "typing",
      onInput: setDraft,
      onSubmit: submitDraft,
      prompt: "› ",
      sending: false,
    });
    expect(
      answerView(
        open(["approve"]),
        answerState({ choosing: "approve", typing: true })
      )
    ).toMatchObject({
      hint: "note optional · Enter send · Esc cancel",
      prompt: "approve · note › ",
    });
  });
});

describe("inputState", () => {
  it("reads an open question as pending and anything else as settled", () => {
    expect(
      [
        { choices: [], status: "open" },
        { answer: "merge", choices: [], status: "answered" },
        { choices: [], status: "cancelled" },
        undefined,
      ].map((input) => inputState(input as FeedEntrySnapshot["input"]))
    ).toEqual(["pending", "answered", "cancelled", "answered"]);
  });
});
