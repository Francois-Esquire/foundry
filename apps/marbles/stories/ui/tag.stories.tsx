import { defineStories, story } from "textbook-sh";
import { Tag } from "~/components/ui/tag";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "./frame";

const size = { height: 3, width: 40 };

export default defineStories({
  component: "Tag",
  description: "A bracketed label in one colour.",
  title: "UI/Tag",
});

export const Default = story({
  description: "The default primary colour.",
  name: "Default",
  render: (renderer) => renderFrame(renderer, <Tag>workflow</Tag>, size),
});

export const Colours = story({
  description: "Tags with custom colours side by side.",
  name: "Colours",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="row" gap={1}>
        <Tag color={theme.colors.success}>monitor</Tag>
        <Tag color={theme.colors.info}>schedule</Tag>
        <Tag color={theme.colors.secondary}>step</Tag>
        <Tag color={theme.colors.error}>failed</Tag>
      </box>,
      size
    ),
});
