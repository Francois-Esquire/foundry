import { useCallback, useEffect, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { IntroActions, IntroDetails } from "~/components/blocks/setup-intro";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "../frame";

const size = { height: 12, width: 64 };

function Providers() {
  return (
    <box flexDirection="column">
      <Text>Detected on this machine</Text>
      <text fg={theme.colors.accent}>Anthropic</text>
      <text fg={theme.colors.accent}>OpenAI</text>
    </box>
  );
}

function SaveProviders() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("Nothing chosen yet");
  const [error, setError] = useState<string | undefined>();
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setTimeout(() => {
      setBusy(false);
      if (attempts === 1) {
        setError("Could not save providers: ~/.foundry is read-only.");
        setOutcome("Save failed; click again to retry");
      } else {
        setError(undefined);
        setOutcome("Providers saved");
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [attempts, busy]);
  const save = useCallback(() => {
    setAttempts((count) => count + 1);
    setBusy(true);
  }, []);
  const skip = useCallback(() => {
    setError(undefined);
    setOutcome("Skipped");
  }, []);
  return (
    <>
      <IntroDetails error={error} workspace="foundry">
        <Providers />
        <Text>{outcome}</Text>
      </IntroDetails>
      <IntroActions
        busy={busy}
        onContinue={save}
        onSkip={skip}
        primary="Enter · Use detected providers"
      />
    </>
  );
}

export default defineStories({
  component: "IntroDetails",
  description:
    "The setup screens' body and actions: IntroDetails names the workspace and shows any error; IntroActions holds the choices.",
  title: "Blocks/SetupIntro",
});

export const Save = story({
  description:
    "Click the primary action: it saves for a moment, fails the first time, and succeeds after.",
  name: "Save and retry",
  render: (renderer) => renderFrame(renderer, <SaveProviders />, size),
});

export const Details = story({
  description: "The workspace line above the screen's own content.",
  name: "Details",
  render: (renderer) =>
    renderFrame(
      renderer,
      <IntroDetails workspace="foundry">
        <Providers />
        <Text>Use these providers for all workspaces.</Text>
      </IntroDetails>,
      size
    ),
});

export const DetailsError = story({
  description: "An error from the last action, below the content.",
  name: "Details with error",
  render: (renderer) =>
    renderFrame(
      renderer,
      <IntroDetails
        error="Could not create .foundry/marbles: permission denied (EACCES). Check the folder's owner and try again."
        workspace="foundry"
      >
        <Text>Marbles will create .foundry/marbles with a starter step.</Text>
      </IntroDetails>,
      size
    ),
});

export const WithSkip = story({
  description: "The primary action and Esc · Skip.",
  name: "Actions with skip",
  render: (renderer) =>
    renderFrame(
      renderer,
      <IntroActions
        busy={false}
        onContinue={ignore}
        onSkip={ignore}
        primary="Enter · Use detected providers"
      />,
      { height: 5, width: 64 }
    ),
});

export const WithoutSkip = story({
  description: "Only the primary action, when there is nothing to skip.",
  name: "Actions without skip",
  render: (renderer) =>
    renderFrame(
      renderer,
      <IntroActions
        busy={false}
        onContinue={ignore}
        primary="Enter · Load Marbles"
      />,
      { height: 5, width: 64 }
    ),
});

export const Busy = story({
  description: "While saving, the actions give way to Saving….",
  name: "Actions busy",
  render: (renderer) =>
    renderFrame(
      renderer,
      <IntroActions
        busy
        onContinue={ignore}
        onSkip={ignore}
        primary="Enter · Use detected providers"
      />,
      { height: 5, width: 64 }
    ),
});

export const NarrowActions = story({
  description: "In a narrow screen the actions wrap onto two rows.",
  name: "Actions, narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <IntroActions
        busy={false}
        onContinue={ignore}
        onSkip={ignore}
        primary="Enter · Use detected providers"
      />,
      { height: 6, width: 36 }
    ),
});
