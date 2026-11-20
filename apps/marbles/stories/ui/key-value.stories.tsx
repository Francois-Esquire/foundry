import { defineStories, story } from "textbook-sh";
import { KeyValue } from "~/components/ui/key-value";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "../frame";

const size = { height: 7, width: 50 };

const facts = [
  { key: "Run", value: "run_01HZ8" },
  { key: "Status", value: "running" },
  { key: "Started", value: "09:14:02" },
  { key: "Elapsed", value: "2m 18s" },
];

export default defineStories({
  component: "KeyValue",
  description: "Aligned key and value rows with a separator.",
  title: "UI/KeyValue",
});

export const Facts = story({
  description:
    "Keys padded to the longest key, the default colon, and default colours.",
  name: "Facts",
  render: (renderer) => renderFrame(renderer, <KeyValue items={facts} />, size),
});

export const FixedKeyWidth = story({
  description: "A fixed key column wider than the longest key.",
  name: "Fixed key width",
  render: (renderer) =>
    renderFrame(renderer, <KeyValue items={facts} keyWidth={14} />, size),
});

export const Separator = story({
  description: "A custom separator between keys and values.",
  name: "Separator",
  render: (renderer) =>
    renderFrame(renderer, <KeyValue items={facts} separator="→" />, size),
});

export const Colours = story({
  description: "Custom key and value colours for every row.",
  name: "Colours",
  render: (renderer) =>
    renderFrame(
      renderer,
      <KeyValue
        items={facts}
        keyColor={theme.colors.info}
        valueColor={theme.colors.accent}
      />,
      size
    ),
});

export const RowColours = story({
  description:
    "Rows that set their own value colour, with styled inline values.",
  name: "Row colours",
  render: (renderer) =>
    renderFrame(
      renderer,
      <KeyValue
        items={[
          { color: theme.colors.success, key: "Passed", value: "18 checks" },
          { color: theme.colors.error, key: "Failed", value: "2 checks" },
          {
            key: "Cost",
            value: (
              <>
                <strong>$0.42</strong>
                <span fg={theme.colors.mutedForeground}> estimated</span>
              </>
            ),
          },
        ]}
      />,
      size
    ),
});

export const LongValue = story({
  description: "A value longer than the row wraps beside its key.",
  name: "Long value",
  render: (renderer) =>
    renderFrame(
      renderer,
      <KeyValue
        items={[
          {
            key: "Summary",
            value:
              "Collected twelve pull requests and wrote a digest for the team channel",
          },
          { key: "Status", value: "complete" },
        ]}
      />,
      { height: 7, width: 34 }
    ),
});
