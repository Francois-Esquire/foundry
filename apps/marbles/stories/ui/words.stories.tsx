import { defineStories, story } from "textbook-sh";
import { theme } from "~/components/ui/theme";
import { Words } from "~/components/ui/words";
import { renderFrame } from "../frame";

export default defineStories({
  component: "Words",
  description:
    "Text that wraps only at spaces, so paths, dates and numbers stay whole.",
  title: "UI/Words",
});

export const Path = story({
  description: "A path that does not fit moves to the next line whole.",
  name: "Path",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Words fg={theme.colors.mutedForeground}>
        Add schedule() or monitor() in .foundry/marbles when you want automatic
        runs.
      </Words>,
      { height: 6, width: 44 }
    ),
});

export const Indented = story({
  description: "An indented line keeps its indent on every wrapped line.",
  name: "Indented",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Words fg={theme.colors.mutedForeground} indent={2}>
        45.2k tokens (40.0k in · 5.2k out) · 4 turns
      </Words>,
      { height: 6, width: 30 }
    ),
});

export const LongToken = story({
  description:
    "A token wider than the line breaks between characters as a last resort.",
  name: "Long token",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Words>Saved to .foundry/marbles/workspaces/handbook/output.jsonl</Words>,
      { height: 6, width: 24 }
    ),
});
