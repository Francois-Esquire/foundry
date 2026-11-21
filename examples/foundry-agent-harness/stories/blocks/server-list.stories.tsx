import { defineStories, story } from "textbook-sh";
import { ServerList } from "@/components/blocks/server-list";
import { context } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 10, width: 44 };

export default defineStories({
  component: "ServerList",
  description: "The MCP servers the harness adds, with their tools.",
  title: "Blocks/ServerList",
});

export const None = story({
  description: "No servers added.",
  name: "None",
  render: (renderer) =>
    renderFrame(renderer, <ServerList servers={[]} />, size),
});

export const Listed = story({
  description: "The backlog server and its one tool.",
  name: "Listed",
  render: (renderer) =>
    renderFrame(renderer, <ServerList servers={context.servers} />, size),
});
