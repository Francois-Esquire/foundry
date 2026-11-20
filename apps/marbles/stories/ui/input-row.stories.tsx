import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { InputRow } from "~/components/ui/input-row";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "../frame";

const LONG_ANSWER =
  "Ship it after the nightly digest finishes and the docs are rebuilt";

function TypedRow({
  labels,
  hint,
  initial,
}: {
  readonly labels: readonly string[];
  readonly hint?: string;
  readonly initial: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <InputRow
      focused
      labels={labels}
      onInput={setValue}
      onSubmit={ignore}
      value={value}
      {...(hint ? { hint } : {})}
    />
  );
}

export default defineStories({
  component: "InputRow",
  description:
    "A one-line label, input and hint. The hint gives way first, then the label takes its shorter form, then it is cut; the input keeps at least twelve cells.",
  title: "UI/InputRow",
});

export const Roomy = story({
  description: "Room for the label, the input and the hint.",
  name: "Roomy",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TypedRow
        hint="Enter send · Esc cancel"
        initial="Keep the examples"
        labels={["steer write ›"]}
      />,
      { height: 5, width: 80 }
    ),
});

export const HintGivesWay = story({
  description:
    "Too narrow for the hint: it is left out, the label stays whole.",
  name: "Hint gives way",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TypedRow
        hint="Enter send · Esc cancel"
        initial="Keep the examples"
        labels={["steer write ›"]}
      />,
      { height: 5, width: 44 }
    ),
});

export const ShorterLabel = story({
  description:
    "Too narrow for the full label: the shorter form takes its place.",
  name: "Shorter label",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TypedRow
        hint="Enter send · Esc cancel"
        initial="Skip the changelog"
        labels={[
          "resume update.write-changes · prompt optional ›",
          "resume update.write-changes ›",
        ]}
      />,
      { height: 5, width: 60 }
    ),
});

export const LongAnswerNarrowPanel = story({
  description:
    "A long typed answer in a narrow bordered box, as in the feed reader: the label stays whole and the answer scrolls.",
  name: "Long answer, narrow panel",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box
        border
        borderColor={theme.colors.warning}
        borderStyle="rounded"
        flexDirection="column"
        paddingX={1}
        title="Needs your input"
      >
        <TypedRow initial={LONG_ANSWER} labels={["merge · note ›"]} />
      </box>,
      { height: 7, width: 40 }
    ),
});
