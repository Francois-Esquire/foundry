import { defineStories, story } from "textbook-sh";
import { KeyboardHelp } from "~/components/blocks/keyboard-help";
import { helpSections } from "~/tui/state/dashboard-commands";
import { renderFrame } from "../frame";

const size = { height: 24, padded: false, width: 80 };

export default defineStories({
  component: "KeyboardHelp",
  description:
    "A scrollable panel listing every key by section, from the dashboard's command table.",
  title: "Blocks/KeyboardHelp",
});

export const Default = story({
  description:
    "The dashboard's real help sections; arrows scroll the list while it is active.",
  name: "Default",
  render: (renderer) =>
    renderFrame(renderer, <KeyboardHelp sections={helpSections()} />, size),
});

export const Inactive = story({
  description: "Help behind the quit dialog: not focused and not scrollable.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <KeyboardHelp active={false} sections={helpSections()} />,
      size
    ),
});

export const OneSection = story({
  description: "A single short section, shorter than the panel.",
  name: "One section",
  render: (renderer) =>
    renderFrame(
      renderer,
      <KeyboardHelp
        sections={[
          {
            items: [
              { key: "?", value: "Open or close keyboard help" },
              { key: "q", value: "Quit" },
            ],
            title: "General",
          },
        ]}
      />,
      { ...size, height: 12 }
    ),
});

export const Narrow = story({
  description: "A narrow terminal; long descriptions wrap.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <KeyboardHelp sections={helpSections()} />, {
      ...size,
      width: 40,
    }),
});
