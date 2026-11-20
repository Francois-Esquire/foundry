import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";
import { renderFrame } from "../frame";

const size = { height: 5, width: 50 };

function SearchInput() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("nothing yet");
  const submit = useCallback(() => setSubmitted(query), [query]);
  return (
    <>
      <TextInput
        focused
        onInput={setQuery}
        onSubmit={submit}
        placeholder="Search marbles"
        value={query}
      />
      <Text>Submitted: {submitted}</Text>
    </>
  );
}

export default defineStories({
  component: "TextInput",
  description: "A single-line themed input.",
  title: "UI/TextInput",
});

export const Typing = story({
  description: "A focused input with a placeholder; type, then Enter submits.",
  name: "Typing",
  render: (renderer) => renderFrame(renderer, <SearchInput />, size),
});

export const Placeholder = story({
  description: "An unfocused empty input shows its placeholder.",
  name: "Placeholder",
  render: (renderer) =>
    renderFrame(renderer, <TextInput placeholder="Search marbles" />, size),
});

export const Filled = story({
  description: "An unfocused input holding a value.",
  name: "Filled",
  render: (renderer) =>
    renderFrame(renderer, <TextInput value="nightly-digest" />, size),
});

export const Overflowing = story({
  description: "A value longer than a narrow input shows only what fits.",
  name: "Overflowing",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TextInput value="summarise every merged pull request from last week" />,
      { height: 3, width: 22 }
    ),
});
