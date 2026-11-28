import { act, useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { encounter, step } from "./helpers/encounters";
import { mount, unmount } from "./helpers/render";

const drawn: string[] = [];

vi.mock("@/components/blocks/reply", () => ({
  Reply: ({ markdown }: { readonly markdown: string }) => {
    drawn.push(markdown);
    return <text>{markdown}</text>;
  },
}));

const { Conversation } = await import("../src/components/blocks/conversation");

const encounters = [
  encounter({
    error: "stopped",
    goal: "asked",
    steps: [
      step({ text: "first", title: "first" }),
      step({ text: "second", title: "second" }),
      step({ streaming: true, text: "third", title: "third" }),
    ],
  }),
];

let tick: ((frame: number) => void) | undefined;
function Ticking() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    tick = setFrame;
    return () => {
      tick = undefined;
    };
  }, []);
  return (
    <Conversation clock={{ frame, now: frame * 80 }} encounters={encounters} />
  );
}

afterEach(unmount);

test("a clock tick redraws the streaming reply and leaves finished ones alone", async () => {
  await mount(<Ticking />);
  expect(drawn).toEqual(["asked", "first", "second", "third", "stopped"]);
  drawn.length = 0;

  for (const frame of [1, 2, 3]) {
    await act(async () => tick?.(frame));
  }

  expect(drawn).toEqual(["third", "third", "third"]);
});
