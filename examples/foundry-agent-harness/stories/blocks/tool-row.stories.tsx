import { defineStories, story } from "textbook-sh";
import { ToolRow } from "@/components/blocks/tool-row";
import { clock } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 4, width: 60 };

export default defineStories({
  component: "ToolRow",
  description: "One tool call: its state, name, and what it was given.",
  title: "Blocks/ToolRow",
});

export const Running = story({
  description: "A call in flight, with a timer.",
  name: "Running",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ToolRow
        clock={clock}
        tool={{
          detail: "bun run --help",
          id: "1",
          name: "Bash",
          startedAt: clock.now - 4200,
          status: "running",
        }}
      />,
      size
    ),
});

export const Succeeded = story({
  description: "A finished call.",
  name: "Succeeded",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ToolRow
        clock={clock}
        tool={{
          detail: "package.json",
          id: "1",
          name: "Read",
          startedAt: clock.now - 4200,
          status: "success",
        }}
      />,
      size
    ),
});

export const Failed = story({
  description: "A failed call with the first line of its error.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ToolRow
        clock={clock}
        tool={{
          detail: "missing.json",
          error: "File does not exist.",
          id: "1",
          name: "Read",
          startedAt: clock.now - 4200,
          status: "error",
        }}
      />,
      size
    ),
});

export const LongDetail = story({
  description: "A detail too long for the row is shortened in the middle.",
  name: "Long detail",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ToolRow
        clock={clock}
        tool={{
          detail:
            "examples/foundry-agent-harness/src/components/blocks/conversation.tsx",
          id: "1",
          name: "Read",
          startedAt: clock.now - 4200,
          status: "success",
        }}
      />,
      size
    ),
});
