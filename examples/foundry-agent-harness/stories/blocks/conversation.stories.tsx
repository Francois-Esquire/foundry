import { defineStories, story } from "textbook-sh";
import { Conversation } from "@/components/blocks/conversation";
import { clock, threads } from "../fixtures/threads";
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
      <Conversation clock={clock} encounters={threads.idle.encounters} />,
      size
    ),
});

export const Working = story({
  description: "One finished task and one still streaming.",
  name: "Working",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation clock={clock} encounters={threads.working.encounters} />,
      size
    ),
});

export const Done = story({
  description: "A finished reply with Markdown and a code block.",
  name: "Done",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation clock={clock} encounters={threads.done.encounters} />,
      size
    ),
});

export const Failed = story({
  description: "A tool's error and why the harness stopped.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Conversation clock={clock} encounters={threads.failed.encounters} />,
      size
    ),
});
