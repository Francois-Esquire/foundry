import { act, useEffect, useState } from "react";
import { afterEach, expect, test } from "vitest";
import { Conversation } from "../src/components/blocks/conversation";
import type { Encounter } from "../src/model/thread";
import { encounter, step } from "./helpers/encounters";
import { frameWith, mount, unmount } from "./helpers/render";

const REPLY = [
  "Run the example from the repository root.",
  "",
  "```sh",
  "bun run build -F @foundry.sh/marbles",
  "bun run start",
  "```",
  "",
  "- The first command builds Marbles",
  "- The second starts the harness",
].join("\n");

const SIZE = { height: 14, width: 60 };
const CLOCK = { frame: 0, now: 0 };

function reply(text: string, streaming: boolean): Encounter[] {
  return [
    encounter({
      goal: "Explain",
      steps: [step({ streaming, text, title: "Explain" })],
    }),
  ];
}

let grow: ((length: number) => void) | undefined;
function Streamed() {
  const [length, setLength] = useState(12);
  useEffect(() => {
    grow = setLength;
    return () => {
      grow = undefined;
    };
  }, []);
  return (
    <Conversation
      clock={CLOCK}
      encounters={reply(REPLY.slice(0, length), length < REPLY.length)}
    />
  );
}

afterEach(unmount);

test("a reply that arrived in pieces ends up drawn like one that arrived whole", async () => {
  const whole = await frameWith(
    await mount(
      <Conversation clock={CLOCK} encounters={reply(REPLY, false)} />,
      SIZE
    ),
    "The second starts the harness"
  );
  const ui = await mount(<Streamed />, SIZE);
  for (let length = 12; length < REPLY.length + 9; length += 9) {
    await act(async () => grow?.(length));
    await frameWith(ui, "Run the");
  }

  expect(await frameWith(ui, "The second starts the harness")).toBe(whole);
  expect(whole).toContain(
    [
      "Run the example from the repository root.",
      "",
      "bun run build -F @foundry.sh/marbles",
      "bun run start",
      "",
      "- The first command builds Marbles",
    ]
      .map((line) => line.padEnd(SIZE.width))
      .join("\n")
  );
});
