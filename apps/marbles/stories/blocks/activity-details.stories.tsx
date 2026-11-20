import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import {
  ActivityDetails,
  type ActivityView,
  type Fact,
} from "~/components/blocks/activity-details";
import { Text } from "~/components/ui/text";
import { ignore, renderFrame } from "../frame";

const size = { height: 18, width: 60 };

const facts: readonly Fact[] = [
  { key: "Kind", value: "subagent" },
  { key: "Status", value: "running" },
  { key: "Harness", value: "claude-code" },
  { key: "Agent", value: "doc-writer" },
  { key: "Lifetime", value: "session" },
  { key: "Session", value: "ses-7f2a" },
  { key: "Activity", value: "act-31" },
];

const running: ActivityView<string> = {
  breadcrumb: { label: "run-104", selection: "run-104" },
  facts,
  summary: "Rewriting the CLI reference from the changed command table.",
  title: "Update the CLI reference",
  waiting: false,
};

function ClickableBreadcrumb() {
  const [inspected, setInspected] = useState<string>();
  return (
    <>
      <ActivityDetails activity={running} onInspect={setInspected} />
      <Text>Inspected: {inspected ?? "nothing yet"}</Text>
    </>
  );
}

export default defineStories({
  component: "ActivityDetails",
  description:
    "A harness activity's breadcrumb back to its run, title, facts, and summary.",
  title: "Blocks/ActivityDetails",
});

export const Running = story({
  description: "A running subagent with a summary of what it is doing.",
  name: "Running",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ActivityDetails activity={running} onInspect={ignore} />,
      size
    ),
});

export const Waiting = story({
  description:
    "An activity waiting on an answer, with a pointer to the Feed to respond.",
  name: "Waiting",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ActivityDetails
        activity={{
          ...running,
          facts: [
            { key: "Kind", value: "task" },
            { key: "Status", value: "Waiting for answer" },
            ...facts.slice(2),
          ],
          summary: "Asked whether to merge the docs update.",
          title: "Merge the docs update",
          waiting: true,
        }}
        onInspect={ignore}
      />,
      size
    ),
});

export const WithoutSummary = story({
  description:
    "A finished activity with no summary, including its native and parent ids.",
  name: "Without summary",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ActivityDetails
        activity={{
          breadcrumb: { label: "run-102", selection: "run-102" },
          facts: [
            { key: "Kind", value: "watch" },
            { key: "Status", value: "complete" },
            ...facts.slice(2),
            { key: "Native ID", value: "toolu_01HXR9" },
            { key: "Parent", value: "act-30" },
          ],
          title: "Watch the test run",
          waiting: false,
        }}
        onInspect={ignore}
      />,
      { ...size, height: 20 }
    ),
});

export const LongSummary = story({
  description: "A long title and summary wrap in a narrow panel.",
  name: "Long summary",
  render: (renderer) =>
    renderFrame(
      renderer,
      <ActivityDetails
        activity={{
          ...running,
          summary:
            "Reading every command handler under src/cli, comparing its flags against the reference page, and rewriting each section whose options, defaults, or examples have drifted since the last release.",
          title:
            "Update the CLI reference and every example that mentions a renamed flag",
        }}
        onInspect={ignore}
      />,
      { height: 24, width: 40 }
    ),
});

export const ClickBreadcrumb = story({
  description: "Clicking the run breadcrumb reports the selection it opens.",
  name: "Click breadcrumb",
  render: (renderer) => renderFrame(renderer, <ClickableBreadcrumb />, size),
});
