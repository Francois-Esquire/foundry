import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { PromptBar } from "~/components/blocks/prompt-bar";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "../frame";

const size = { height: 5, width: 80 };
const interactive = { height: 7, width: 80 };

type PromptKind = "steer" | "resume";

function SendPrompt({ kind }: { readonly kind: PromptKind }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(true);
  const [sent, setSent] = useState("nothing yet");
  const cancel = useCallback(() => {
    setDraft("");
    setOpen(false);
    setSent("cancelled");
  }, []);
  const submit = useCallback(() => {
    setSent(draft === "" ? "(no prompt)" : draft);
    setDraft("");
    setOpen(false);
  }, [draft]);
  useKeyboard((key) => {
    if (key.name === "escape" && open) {
      key.preventDefault();
      cancel();
    }
    if (key.name === "s" && !open) {
      key.preventDefault();
      setOpen(true);
    }
  });
  return (
    <>
      {open ? (
        <PromptBar
          draft={draft}
          focused
          kind={kind}
          onInput={setDraft}
          onSubmit={submit}
          stepId="write"
        />
      ) : (
        <Text>Prompt closed</Text>
      )}
      <Action
        active
        id="prompt-bar-story:toggle"
        label={open ? "[ Cancel ]" : "[ Open prompt ] or press s"}
        onAction={open ? cancel : setOpen}
        value
      />
      <Text>Sent: {sent}</Text>
    </>
  );
}

export default defineStories({
  component: "PromptBar",
  description:
    "The line below the dashboard for steering a running step or resuming a paused one.",
  title: "Blocks/PromptBar",
});

export const Steer = story({
  description:
    "Type a steer for a running step; Enter sends it, Escape or Cancel closes it, s or Open prompt reopens it.",
  name: "Steer",
  render: (renderer) =>
    renderFrame(renderer, <SendPrompt kind="steer" />, interactive),
});

export const Resume = story({
  description:
    "Resume a paused step; the prompt is optional, so Enter on an empty draft resumes too.",
  name: "Resume",
  render: (renderer) =>
    renderFrame(renderer, <SendPrompt kind="resume" />, interactive),
});

export const Drafted = story({
  description: "A steer with a draft typed, before it is sent.",
  name: "With a draft",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PromptBar
        draft="Keep the existing examples and only add relink."
        focused
        kind="steer"
        onInput={ignore}
        onSubmit={ignore}
        stepId="write"
      />,
      size
    ),
});

export const Unfocused = story({
  description: "Without focus, as while the quit dialog is open.",
  name: "Unfocused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PromptBar
        draft="Keep the existing examples"
        focused={false}
        kind="resume"
        onInput={ignore}
        onSubmit={ignore}
        stepId="write"
      />,
      size
    ),
});

export const Narrow = story({
  description:
    "A long step ID in a narrow terminal leaves little room for the draft.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PromptBar
        draft="Skip the changelog"
        focused
        kind="resume"
        onInput={ignore}
        onSubmit={ignore}
        stepId="update.write-changes"
      />,
      { height: 5, width: 60 }
    ),
});

export const VeryNarrow = story({
  description:
    "Narrower still: the hint goes first, then the optional note, and the step ID is shortened last.",
  name: "Very narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PromptBar
        draft="Skip the changelog"
        focused
        kind="resume"
        onInput={ignore}
        onSubmit={ignore}
        stepId="update.write-changes"
      />,
      { height: 5, width: 40 }
    ),
});

export const ResumeShortStep = story({
  description:
    "Resuming a step with a short ID leaves room for the note, the draft and the hint, from the first frame.",
  name: "Resume, short step",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PromptBar
        draft="Skip the changelog"
        focused
        kind="resume"
        onInput={ignore}
        onSubmit={ignore}
        stepId="write"
      />,
      size
    ),
});
