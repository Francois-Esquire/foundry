import { defineStories, story } from "textbook-sh";
import { ValueViewer } from "~/components/blocks/value-viewer";
import type { JsonValue } from "~/model/json";
import { renderFrame } from "../frame";

const size = { height: 8, width: 60 };

const input: JsonValue = {
  options: { check: true, depth: 2 },
  paths: ["src/cli.ts", "src/cli/app.tsx"],
  reason: "Merged pull request #482",
};

const nested: JsonValue = {
  "a.b": { note: "A dotted key is a single path segment." },
  batches: [
    { paths: ["a.ts", "b.ts"] },
    { options: { check: true }, paths: ["c.ts"] },
    { options: { check: false, retries: 3 }, paths: ["d.ts", "e.ts", "f.ts"] },
  ],
  summary: {
    changed: 6,
    pages: ["README.md", "docs/feed.md", "docs/logs.md"],
    reviewer: { model: "claude-sonnet-5-5", provider: "anthropic" },
  },
};

export default defineStories({
  component: "ValueViewer",
  description:
    "A recorded input or output: objects as a JSON tree, other values as text.",
  title: "Blocks/ValueViewer",
});

export const Empty = story({
  description: "No value recorded shows the empty message.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No input recorded." focused value={undefined} />,
      size
    ),
});

export const PlainText = story({
  description: "A string value prints as plain text, without quotes.",
  name: "Text",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer
        empty="No output recorded."
        focused
        value="Reviewed 3 files. No issues found."
      />,
      size
    ),
});

export const NumberValue = story({
  description: "A number prints as JSON.",
  name: "Number",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No output recorded." focused value={42} />,
      size
    ),
});

export const BooleanValue = story({
  description: "A boolean prints as JSON.",
  name: "Boolean",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No output recorded." focused value={false} />,
      size
    ),
});

export const NullValue = story({
  description:
    "A recorded null prints as null, unlike a missing value, which shows the empty message.",
  name: "Null",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No output recorded." focused value={null} />,
      size
    ),
});

export const ObjectFocused = story({
  description:
    "A focused object as a JSON tree; arrows browse and Space folds nodes.",
  name: "Object, focused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No input recorded." focused value={input} />,
      { height: 12, width: 60 }
    ),
});

export const ObjectUnfocused = story({
  description: "The same tree unfocused, without a highlighted node.",
  name: "Object, unfocused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No input recorded." focused={false} value={input} />,
      { height: 12, width: 60 }
    ),
});

export const ArrayValue = story({
  description: "A top-level array is a JSON tree too.",
  name: "Array",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer
        empty="No output recorded."
        focused
        value={["README.md", "docs/feed.md", "docs/logs.md"]}
      />,
      size
    ),
});

export const Nested = story({
  description: "A deep value taller than its frame; arrows scroll through it.",
  name: "Nested and long",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ValueViewer empty="No input recorded." focused value={nested} />,
      { height: 14, width: 60 }
    ),
});
