import { defineStories, story } from "textbook-sh";
import { SetupFlow } from "~/components/layouts/setup-flow";
import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { ignore } from "../frame";
import { renderReactStory } from "../render-react-story";
import { Slot } from "./slot";

const footer = (
  <Slot detail="Actions for this step" grow={false} label="footer" />
);

const lines = Array.from(
  { length: 40 },
  (_, index) => `Line ${index + 1} of the content`
);

export default defineStories({
  component: "SetupFlow",
  description:
    "The centred, framed screen of onboarding, launch, and errors. It sizes itself from the terminal: at most 80 columns wide and its maximum height tall.",
  title: "Layouts/SetupFlow",
});

export const Default = story({
  description: "Content and a footer at the default maximum height of 36 rows.",
  name: "Default",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SetupFlow footer={footer} title="Set up your workspace">
        <Slot
          detail="Scrolls when it is taller than the frame"
          label="content"
        />
      </SetupFlow>
    ),
});

export const Short = story({
  description: "A maximum height of 15 rows, as the intro screens use.",
  name: "Short",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SetupFlow footer={footer} maxHeight={15} title="Open this workspace">
        <Slot label="content" />
      </SetupFlow>
    ),
});

export const NoFooter = story({
  description: "Without a footer the content fills the frame.",
  name: "No footer",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SetupFlow maxHeight={15} title="Marbles could not load">
        <Slot label="content" />
      </SetupFlow>
    ),
});

export const Scrolling = story({
  description: "Content longer than the frame scrolls inside it.",
  name: "Scrolling content",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SetupFlow footer={footer} maxHeight={20} title="Review and create">
        {lines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </SetupFlow>
    ),
});

export const Overlay = story({
  description: "An overlay, such as the quit dialog, sits over the frame.",
  name: "With overlay",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SetupFlow
        footer={footer}
        maxHeight={15}
        overlay={
          <Dialog onCancel={ignore} onConfirm={ignore} title="overlay">
            <text fg={theme.colors.mutedForeground}>
              Covers the setup frame
            </text>
          </Dialog>
        }
        title="Set up your workspace"
      >
        <Slot label="content" />
      </SetupFlow>
    ),
});
