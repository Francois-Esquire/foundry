import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import {
  CatalogDetails,
  type CatalogDetailsView,
} from "~/components/blocks/catalog-details";
import { Text } from "~/components/ui/text";
import { statusDisplay } from "~/model/run-status";
import { catalogConfiguration } from "~/tui/state/inspector";
import { ignore, renderFrame } from "../frame";

const size = { height: 22, width: 64 };

const run = (runId: string, status: string) => ({
  key: runId,
  runId,
  selection: runId,
  status: statusDisplay({ status }),
});

const workflow: CatalogDetailsView<string, string> = {
  description: "Find changes, update documentation, and check the result.",
  facts: [
    { key: "Kind", value: "workflow" },
    { key: "Source", value: ".foundry/marbles/docs.ts:12" },
    { key: "Triggers", value: "update-docs" },
  ],
  filter: "definition:docs",
  id: "docs",
  runs: [run("run-104", "running"), run("run-093", "complete")],
};

const schedule: CatalogDetailsView<string, string> = {
  description: "Every weekday at 17:00.",
  facts: [
    { key: "Target", value: "summarize-day" },
    { key: "Status", value: "waiting" },
    { key: "Next", value: "Today at 17:00" },
  ],
  filter: "trigger:daily",
  id: "daily",
  runs: [],
};

const scheduleConfiguration = {
  time: "17:00",
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
};

const history = [
  "running",
  "failed",
  "complete",
  "complete",
  "cancelled",
  "complete",
  "failed",
  "complete",
  "queued",
  "complete",
].map((status, index) => run(`run-${String(110 - index)}`, status));

function Interactive() {
  const [expanded, setExpanded] = useState(false);
  const [event, setEvent] = useState("Nothing clicked yet");
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const report = useCallback(
    (label: string) => (value: string) => setEvent(`${label}: ${value}`),
    []
  );
  return (
    <>
      <CatalogDetails
        configuration={catalogConfiguration(scheduleConfiguration, expanded)}
        details={{ ...schedule, runs: workflow.runs }}
        onFilter={report("Filter")}
        onInspect={report("Inspect")}
        onRollSchedule={report("Run now")}
        onToggleConfiguration={toggle}
      />
      <Text>{event}</Text>
    </>
  );
}

export default defineStories({
  component: "CatalogDetails",
  description:
    "Details of a catalog item: description, facts, configuration, actions, and its runs.",
  title: "Blocks/CatalogDetails",
});

export const Workflow = story({
  description: "A workflow that can be launched, with its recent runs.",
  name: "Workflow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogDetails
        details={workflow}
        onFilter={ignore}
        onInspect={ignore}
        onLaunch={ignore}
        onToggleConfiguration={ignore}
      />,
      size
    ),
});

export const Schedule = story({
  description:
    "A schedule with collapsed configuration, a Run now action, and no runs yet.",
  name: "Schedule",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogDetails
        configuration={{ expanded: false }}
        details={schedule}
        onFilter={ignore}
        onInspect={ignore}
        onRollSchedule={ignore}
        onToggleConfiguration={ignore}
      />,
      size
    ),
});

export const ConfigurationShown = story({
  description: "A monitor with its configuration expanded as JSON.",
  name: "Configuration shown",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogDetails
        configuration={catalogConfiguration(
          { debounce: "500ms", glob: "src/**/*.ts", kind: "files" },
          true
        )}
        details={{
          description: "Watch src/**/*.ts for documentation changes.",
          facts: [
            { key: "Target", value: "update-documentation" },
            { key: "Status", value: "running" },
          ],
          filter: "trigger:docs-monitor",
          id: "docs-monitor",
          runs: [run("run-104", "running")],
        }}
        onFilter={ignore}
        onInspect={ignore}
        onToggleConfiguration={ignore}
      />,
      { ...size, height: 24 }
    ),
});

export const ReadOnly = story({
  description:
    "A step owned by another workspace: no launch and no configuration, only its runs.",
  name: "Read only",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogDetails
        details={{
          description: "Check the configured API endpoint.",
          facts: [
            { key: "Kind", value: "step" },
            { key: "Source", value: "outside workspace" },
          ],
          filter: "definition:api",
          id: "api",
          runs: [run("run-103", "failed")],
        }}
        onFilter={ignore}
        onInspect={ignore}
        onToggleConfiguration={ignore}
      />,
      size
    ),
});

export const ManyRuns = story({
  description: "A long run history in every status, taller than the frame.",
  name: "Many runs",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogDetails
        details={{ ...workflow, runs: history }}
        onFilter={ignore}
        onInspect={ignore}
        onLaunch={ignore}
        onToggleConfiguration={ignore}
      />,
      { ...size, height: 30 }
    ),
});

export const Clickable = story({
  description:
    "Click Show configuration to toggle it; Run now, the filter, and run rows report what they open.",
  name: "Clickable",
  render: (renderer) =>
    renderFrame(renderer, <Interactive />, { ...size, height: 28 }),
});
