import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "./frame";

const size = { height: 5, width: 40 };
const choices = ["Run", "Pause", "Stop"] as const;
type Choice = (typeof choices)[number];

function ActionRow() {
  const [chosen, setChosen] = useState<Choice>("Run");
  return (
    <>
      <box flexDirection="row" gap={2}>
        {choices.map((choice) => (
          <Action
            active={choice === chosen}
            id={`action:${choice}`}
            key={choice}
            label={`[ ${choice} ]`}
            onAction={setChosen}
            value={choice}
          />
        ))}
      </box>
      <Text>Last pressed: {chosen}</Text>
    </>
  );
}

export default defineStories({
  component: "Action",
  description: "A clickable label that is bold and primary when active.",
  title: "UI/Action",
});

export const Inactive = story({
  description: "An inactive action in the muted foreground colour.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Action label="[ Cancel ]" onAction={ignore} value="cancel" />,
      size
    ),
});

export const Active = story({
  description: "An active action, bold in the primary colour.",
  name: "Active",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Action active label="[ Confirm ]" onAction={ignore} value="confirm" />,
      size
    ),
});

export const ClickToChoose = story({
  description: "A row of actions; clicking one makes it the active choice.",
  name: "Click to choose",
  render: (renderer) => renderFrame(renderer, <ActionRow />, size),
});
