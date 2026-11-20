import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "../frame";

const size = { height: 24, padded: false, width: 80 };

function Backdrop() {
  return (
    <box flexDirection="column" gap={1} padding={1}>
      <Text>marbles / foundry</Text>
      <text fg={theme.colors.mutedForeground}>
        update-documentation running · 2 monitors watching
      </text>
    </box>
  );
}

function AskToQuit({ hosted }: { readonly hosted: boolean }) {
  const [open, setOpen] = useState(true);
  const [outcome, setOutcome] = useState("Nothing chosen yet");
  const cancel = useCallback(() => {
    setOutcome("Kept open");
    setOpen(false);
  }, []);
  const confirm = useCallback(() => {
    setOutcome("Quit chosen");
    setOpen(false);
  }, []);
  useKeyboard((key) => {
    if (key.name === "q" && !open) {
      key.preventDefault();
      setOpen(true);
    }
  });
  return (
    <>
      <Backdrop />
      <box flexDirection="column" gap={1} paddingX={1}>
        <Text>{outcome}</Text>
        <Action
          active={!open}
          id="quit-dialog-story:open"
          label="[ Ask again ] or press q"
          onAction={setOpen}
          value
        />
      </box>
      {open && (
        <QuitDialog hosted={hosted} onCancel={cancel} onConfirm={confirm} />
      )}
    </>
  );
}

export default defineStories({
  component: "QuitDialog",
  description:
    "The quit confirmation, explaining what keeps running and what stops.",
  title: "Blocks/QuitDialog",
});

export const Session = story({
  description:
    "Quitting a dashboard that hosts its own session stops its triggers and running steps.",
  name: "This session",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Backdrop />
        <QuitDialog onCancel={ignore} onConfirm={ignore} />
      </>,
      size
    ),
});

export const Hosted = story({
  description:
    "Quitting a dashboard joined to the Marbles process leaves the work running there.",
  name: "Hosted",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Backdrop />
        <QuitDialog hosted onCancel={ignore} onConfirm={ignore} />
      </>,
      size
    ),
});

export const Choose = story({
  description:
    "Tab or arrows choose, Enter or a click closes the dialog; Ask again or q reopens it.",
  name: "Choose",
  render: (renderer) =>
    renderFrame(renderer, <AskToQuit hosted={false} />, size),
});

export const Narrow = story({
  description: "In a narrow terminal the notice and the hint line wrap.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <QuitDialog onCancel={ignore} onConfirm={ignore} />, {
      height: 24,
      padded: false,
      width: 48,
    }),
});

export const Short = story({
  description:
    "In a short terminal the dialog keeps its title, buttons, and hint inside the frame, and the notice scrolls.",
  name: "Short",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Backdrop />
        <QuitDialog onCancel={ignore} onConfirm={ignore} />
      </>,
      { height: 12, padded: false, width: 64 }
    ),
});
