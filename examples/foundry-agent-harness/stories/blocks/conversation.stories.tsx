import { defineStories, story } from "textbook-sh";
import { Conversation } from "@/components/blocks/conversation";
import { threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 22, width: 76 };

export default defineStories({
  component: "Conversation",
  description: "The goal, each task with its tool calls, and the replies.",
  title: "Blocks/Conversation",
});

export const Welcome = story({
  description: "No messages yet, so it explains what a goal does.",
  name: "Welcome",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation messages={threads.idle.messages} />,
      size
    ),
});

export const Working = story({
  description: "One finished task and one still streaming.",
  name: "Working",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation messages={threads.working.messages} />,
      size
    ),
});

export const Done = story({
  description: "A finished reply with Markdown and a code block.",
  name: "Done",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation messages={threads.done.messages} />,
      size
    ),
});

export const Failed = story({
  description: "A tool's error and why the harness stopped.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation messages={threads.failed.messages} />,
      size
    ),
});
