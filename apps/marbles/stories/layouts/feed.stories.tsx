import { defineStories, story } from "textbook-sh";
import { FeedLayout } from "~/components/layouts/feed";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "../frame";
import { Slot } from "./slot";

function Arranged({ width }: { readonly width: number }) {
  return (
    <FeedLayout
      list={
        <Slot detail="Feed entries" label="list" tone={theme.colors.accent} />
      }
      reader={
        <Slot
          detail="The selected entry"
          label="reader"
          tone={theme.colors.primary}
        />
      }
      width={width}
    />
  );
}

function arranged(width: number) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(renderer, <Arranged width={width} />, {
      height: 18,
      padded: false,
      width,
    });
}

export default defineStories({
  component: "FeedLayout",
  description:
    "The feed's list and reader, side by side from 90 columns and stacked below that.",
  title: "Layouts/Feed",
});

export const Wide = story({
  description: "Side by side at 120 columns; the list takes 38% (45 columns).",
  name: "Side by side",
  render: arranged(120),
});

export const AtThreshold = story({
  description: "Side by side at exactly 90 columns, with a 34-column list.",
  name: "Side by side · at threshold",
  render: arranged(90),
});

export const VeryWide = story({
  description: "At 160 columns the list stops growing at 52 columns.",
  name: "Side by side · list at its widest",
  render: arranged(160),
});

export const Stacked = story({
  description:
    "Below 90 columns the list sits above the reader and takes 40% of the height.",
  name: "Stacked",
  render: arranged(70),
});
