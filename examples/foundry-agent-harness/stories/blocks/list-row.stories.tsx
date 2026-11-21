import { defineStories, story } from "textbook-sh";
import { ListRow } from "@/components/blocks/list-row";
import { Spinner } from "@/components/blocks/spinner";
import { defaultTheme } from "@/lib/terminal-themes/default";
import { clock } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 4, width: 44 };
const { colors } = defaultTheme;

export default defineStories({
  component: "ListRow",
  description: "An icon, a title, and an optional note under it.",
  title: "Blocks/ListRow",
});

export const Plain = story({
  description: "A title with a text icon.",
  name: "Plain",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ListRow color={colors.success} icon="✓">
        Read package.json in this directory
      </ListRow>,
      size
    ),
});

export const Noted = story({
  description: "A title with a note.",
  name: "Noted",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ListRow
        color={colors.foreground}
        icon="◆"
        note="How to write the note for a finished task."
      >
        task-notes
      </ListRow>,
      size
    ),
});

export const Running = story({
  description: "A spinner as the icon.",
  name: "Running",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ListRow color={colors.primary} icon={<Spinner frame={clock.frame} />}>
        Planning the goal into to-dos
      </ListRow>,
      size
    ),
});
