import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { Action } from "~/components/ui/action";
import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "../frame";

const size = { height: 22, padded: false, width: 80 };

const paragraphs = [
  "The workspace keeps its configuration in .foundry/marbles.",
  "Resetting it removes every saved trigger, schedule, and monitor checkpoint.",
  "Run history and generated results are kept, but no longer appear in the dashboard.",
  "Steps that are running now are cancelled before the reset begins.",
  "Runs waiting on an answer are dropped and must be started again.",
  "Model credentials stored by the host are not affected.",
  "You can restore the configuration from version control afterwards.",
  "Scroll this body to read the rest before you choose.",
];

function Backdrop() {
  return (
    <box flexDirection="column" gap={1} padding={1}>
      <Text>Marbles · foundry</Text>
      <text fg={theme.colors.mutedForeground}>
        3 workflows · 2 monitors · 1 schedule
      </text>
    </box>
  );
}

function ReopenableDialog() {
  const [open, setOpen] = useState(true);
  const [outcome, setOutcome] = useState("Nothing chosen yet");
  const confirm = useCallback(() => {
    setOutcome("Confirmed: draft discarded");
    setOpen(false);
  }, []);
  const cancel = useCallback(() => {
    setOutcome("Cancelled: draft kept");
    setOpen(false);
  }, []);
  return (
    <>
      <box flexDirection="column" gap={1} padding={1}>
        <Text>{outcome}</Text>
        <Action
          active={!open}
          id="dialog-story:open"
          label="[ Open dialog ]"
          onAction={setOpen}
          value
        />
      </box>
      {open && (
        <Dialog
          confirmLabel="Discard"
          hint="←→ choose · Enter select · or click a button"
          onCancel={cancel}
          onConfirm={confirm}
          title="Discard this draft?"
        >
          <Text>The prompt you typed has not been sent.</Text>
        </Dialog>
      )}
    </>
  );
}

export default defineStories({
  component: "Dialog",
  description:
    "A modal over a dimmed backdrop with a scrollable body and two choices.",
  title: "UI/Dialog",
});

export const Default = story({
  description:
    "The default variant with the OK and Cancel labels and no hint line.",
  name: "Default",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Backdrop />
        <Dialog onCancel={ignore} onConfirm={ignore} title="Save changes?">
          <Text>Your edits to nightly-digest will be written to disk.</Text>
        </Dialog>
      </>,
      size
    ),
});

export const Danger = story({
  description:
    "The danger variant with custom labels and a hint line, as the quit dialog uses.",
  name: "Danger",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Backdrop />
        <Dialog
          cancelLabel="Keep open"
          confirmLabel="Quit"
          hint="Tab choose · Enter select · Esc back · Ctrl+C quit"
          onCancel={ignore}
          onConfirm={ignore}
          title="Quit Marbles?"
          variant="danger"
        >
          <Text>Quitting stops schedules and monitoring for this session.</Text>
          <text fg={theme.colors.warning}>Running steps are cancelled.</text>
        </Dialog>
      </>,
      size
    ),
});

export const LongBody = story({
  description: "A body longer than the dialog, which scrolls inside it.",
  name: "Long body",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Dialog
        confirmLabel="Reset"
        onCancel={ignore}
        onConfirm={ignore}
        title="Reset the workspace?"
        variant="danger"
      >
        {paragraphs.map((paragraph) => (
          <Text key={paragraph}>{paragraph}</Text>
        ))}
      </Dialog>,
      size
    ),
});

export const Choose = story({
  description:
    "A working dialog: arrows move the choice, Enter or a click closes it.",
  name: "Choose and reopen",
  render: (renderer) => renderFrame(renderer, <ReopenableDialog />, size),
});

export const ShortFrame = story({
  description:
    "In a frame shorter than the dialog, the dialog fits the frame and its body scrolls.",
  name: "Short frame",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Backdrop />
        <Dialog
          cancelLabel="Keep open"
          confirmLabel="Quit"
          hint="Tab choose · Enter select · Esc back · Ctrl+C quit"
          onCancel={ignore}
          onConfirm={ignore}
          title="Quit Marbles?"
          variant="danger"
        >
          <Text>Quitting stops schedules and monitoring for this session.</Text>
          <text fg={theme.colors.warning}>Running steps are cancelled.</text>
        </Dialog>
      </>,
      { height: 10, padded: false, width: 60 }
    ),
});
