import { defineStories, story } from "textbook-sh";
import { JSONView } from "~/components/ui/json";
import type { JsonValue } from "~/model/json";
import { renderFrame } from "./frame";

const size = { height: 10, width: 52 };

const result: JsonValue = {
  model: "claude-sonnet",
  ok: true,
  tags: ["daily", "digest"],
  usage: { input: 1204, output: 388 },
};

const issues: JsonValue = [
  "Flaky test in generations",
  "Docs link is broken",
  "Theme ignores light mode",
  "Search drops the last character",
  "Footer hints overflow",
  "Logs lose their scroll position",
  "Dialog steals focus",
  "Sparkles flicker on resize",
  "Run tree collapses unexpectedly",
  "Status bar shows stale cost",
];

export default defineStories({
  component: "JSONView",
  description:
    "A collapsible JSON tree: arrows move the cursor, Space or click folds a branch.",
  title: "UI/JSONView",
});

export const Focused = story({
  description:
    "A nested object with the cursor shown; arrows, Space, and clicks work.",
  name: "Focused",
  render: (renderer) =>
    renderFrame(renderer, <JSONView data={result} focused />, size),
});

export const Unfocused = story({
  description: "The same tree without focus, so no cursor is drawn.",
  name: "Unfocused",
  render: (renderer) =>
    renderFrame(renderer, <JSONView data={result} focused={false} />, size),
});

export const LongArray = story({
  description:
    "An array taller than the view; moving the cursor scrolls it into view.",
  name: "Long array",
  render: (renderer) =>
    renderFrame(renderer, <JSONView data={issues} focused />, size),
});

export const Scalar = story({
  description: "A scalar value renders as a single root line.",
  name: "Scalar",
  render: (renderer) =>
    renderFrame(renderer, <JSONView data="completed" focused />, size),
});

export const EmptyObject = story({
  description: "An empty object shows its zero field count.",
  name: "Empty object",
  render: (renderer) =>
    renderFrame(renderer, <JSONView data={{}} focused />, size),
});
