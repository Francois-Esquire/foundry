import { definitionRows, triggerRows } from "~/cli/state/dashboard-rows";
import { feedRows } from "~/cli/state/feed-model";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { dashboardSnapshot } from "../fixtures/snapshot";

function feedEntry(id: string): FeedEntrySnapshot {
  const entry = dashboardSnapshot.feed.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`The story fixtures need the feed entry ${id}.`);
  }
  return entry;
}

export const pendingEntry = feedEntry("feed-merge");
export const summaryEntry = feedEntry("feed-summary");
const docsEntry = feedEntry("feed-docs");
export const milestoneEntry = feedEntry("feed-setup");

export const answeredEntry: FeedEntrySnapshot = {
  ...pendingEntry,
  id: "feed-merge-answered",
  input: {
    answer: "merge",
    choices: ["merge", "hold"],
    note: "Looks good, ship it.",
    status: "answered",
  },
  posted: "14:35",
  postedAt: "2026-09-22T14:35:00.000Z",
  title: "Merge the docs update?",
};

export const cancelledEntry: FeedEntrySnapshot = {
  ...pendingEntry,
  id: "feed-release-cancelled",
  input: { choices: ["publish", "skip"], status: "cancelled" },
  posted: "13:50",
  postedAt: "2026-09-22T13:50:00.000Z",
  run: "run-090",
  title: "Publish the release notes?",
};

export const freeTextEntry: FeedEntrySnapshot = {
  ...pendingEntry,
  body: [
    "# Name the release",
    "",
    "The changelog is ready. What should this release be called?",
  ].join("\n"),
  id: "feed-release-name",
  input: { choices: [], status: "open" },
  title: "Name the release",
};

export const mediaEntry: FeedEntrySnapshot = {
  ...summaryEntry,
  body: [
    "# Weekly report",
    "",
    "The chart, the recording, and the raw data are attached.",
  ].join("\n"),
  id: "feed-report",
  media: [
    { kind: "image", name: "chart.png", path: "media/chart.png" },
    { kind: "video", name: "walkthrough.mp4", path: "media/walkthrough.mp4" },
    { kind: "audio", name: "standup.m4a", path: "media/standup.m4a" },
    { kind: "file", name: "runs.csv", path: "media/runs.csv" },
  ],
  title: "Weekly report",
};

export const longEntry: FeedEntrySnapshot = {
  ...summaryEntry,
  body: [
    "# Release checklist for the documentation site and every package page",
    "",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `${index + 1}. Check section ${index + 1} renders, links resolve, and code samples still compile against the current API.`
    ),
  ].join("\n"),
  id: "feed-long",
  media: [],
  title:
    "Release checklist for the documentation site and every package page, with notes",
};

export const feedEntries: readonly FeedEntrySnapshot[] = [
  pendingEntry,
  summaryEntry,
  answeredEntry,
  docsEntry,
  cancelledEntry,
  milestoneEntry,
];

export const feedListRows = feedRows(feedEntries, summaryEntry);

export const triggerItems = triggerRows(dashboardSnapshot.triggers, {
  id: "daily",
  kind: "trigger",
});

export const definitionItems = definitionRows(dashboardSnapshot.definitions, {
  id: "docs",
  kind: "definition",
});

export const longDefinitionItems = definitionRows([
  ...dashboardSnapshot.definitions,
  {
    description: "Regenerate every package README from its exports.",
    id: "readmes",
    kind: "workflow",
    name: "regenerate-package-readmes-from-exported-symbols",
    origin: {
      external: false,
      source: ".foundry/marbles/packages/readmes/regenerate.ts:41",
      workspaceId: "ws-foundry",
    },
  },
  {
    description: "A shared step from another workspace.",
    id: "shared-lint",
    kind: "step",
    name: "lint-shared",
    origin: { external: true, source: "../handbook/.foundry/marbles/lint.ts" },
  },
]);
