import { act, useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Message } from "../src/model/thread";
import { mount, unmount } from "./helpers/render";

const drawn: string[] = [];

vi.mock("@/components/blocks/reply", () => ({
  Reply: ({ markdown }: { readonly markdown: string }) => {
    drawn.push(markdown);
    return <text>{markdown}</text>;
  },
}));

const { Conversation } = await import("../src/components/blocks/conversation");

function reply(text: string, streaming: boolean): Message {
  return { kind: "task", streaming, text, title: text, tools: [] };
}

const messages = [
  reply("first", false),
  reply("second", false),
  reply("third", true),
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
    <Conversation clock={{ frame, now: frame * 80 }} messages={messages} />
  );
}

afterEach(unmount);

test("a clock tick redraws the streaming reply and leaves finished ones alone", async () => {
  await mount(<Ticking />);
  expect(drawn).toEqual(["first", "second", "third"]);
  drawn.length = 0;

  for (const frame of [1, 2, 3]) {
    await act(async () => tick?.(frame));
  }

  expect(drawn).toEqual(["third", "third", "third"]);
});
