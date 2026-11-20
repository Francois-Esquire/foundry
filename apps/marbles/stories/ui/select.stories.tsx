import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { Select } from "~/components/ui/select";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "./frame";

const size = { height: 7, width: 40 };

const themes = [
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
  { label: "Follow the terminal", value: "system" },
];

function ThemeSelect({ initial }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Select
        focused
        id="select-story"
        onChange={setValue}
        options={themes}
        value={value}
      />
      <Text>Chosen: {value ?? "none"}</Text>
    </>
  );
}

export default defineStories({
  component: "Select",
  description:
    "A single-choice list: arrows or Space cycle the choice, clicks pick one.",
  title: "UI/Select",
});

export const Focused = story({
  description:
    "A focused select with a choice; arrows, Space, and clicks change it.",
  name: "Focused",
  render: (renderer) =>
    renderFrame(renderer, <ThemeSelect initial="dark" />, size),
});

export const NothingChosen = story({
  description: "A focused select with no value; the first key picks one.",
  name: "Nothing chosen",
  render: (renderer) => renderFrame(renderer, <ThemeSelect />, size),
});

export const Unfocused = story({
  description: "An unfocused select marks its value without highlighting it.",
  name: "Unfocused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Select
        focused={false}
        id="select-story"
        onChange={ignore}
        options={themes}
        value="light"
      />,
      size
    ),
});
