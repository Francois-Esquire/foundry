import { defineStories, story } from "textbook-sh";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "../frame";

const sentence =
  "Quitting stops schedules and monitoring for this session; saved results are kept.";

export default defineStories({
  component: "Text",
  description: "Text in the theme foreground unless a colour is given.",
  title: "UI/Text",
});

export const Default = story({
  description: "The theme foreground colour.",
  name: "Default",
  render: (renderer) =>
    renderFrame(renderer, <Text>3 workflows · 2 monitors</Text>, {
      height: 3,
      width: 40,
    }),
});

export const Coloured = story({
  description: "A custom foreground colour.",
  name: "Coloured",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Text fg={theme.colors.info}>Run filter: nightly-digest</Text>,
      {
        height: 3,
        width: 40,
      }
    ),
});

export const Wrapped = story({
  description: "Long text wraps in a narrow box.",
  name: "Wrapped",
  render: (renderer) =>
    renderFrame(renderer, <Text>{sentence}</Text>, { height: 6, width: 30 }),
});

export const Truncated = story({
  description: "Long text truncated to one line.",
  name: "Truncated",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Text truncate wrapMode="none">
        {sentence}
      </Text>,
      { height: 3, width: 30 }
    ),
});
