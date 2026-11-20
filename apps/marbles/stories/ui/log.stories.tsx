import { defineStories, story } from "textbook-sh";
import { Log } from "~/components/ui/log";
import type { LogEntry } from "~/model/log";
import { renderFrame } from "../frame";

const size = { height: 10, width: 72 };

const levels: readonly LogEntry[] = [
  {
    id: "1",
    level: "debug",
    message: "Loaded 3 workflows",
    timestamp: "09:14:00",
  },
  {
    id: "2",
    level: "info",
    message: "Started nightly-digest",
    timestamp: "09:14:02",
  },
  {
    id: "3",
    level: "warn",
    message: "Model is slow to respond",
    timestamp: "09:14:31",
  },
  {
    id: "4",
    level: "error",
    message: "Step summarise failed",
    timestamp: "09:15:07",
  },
];

const messages = [
  "Fetched pull requests",
  "Grouped 12 changes by area",
  "Asked the model for a summary",
  "Received 388 output tokens",
  "Wrote digest draft",
  "Checked links in the draft",
  "Posted to the team channel",
  "Saved the checkpoint",
  "Scheduled the next run",
  "Released the workspace lock",
  "Cleaned temporary files",
  "Finished nightly-digest",
];

const history: readonly LogEntry[] = messages.map((message, index) => ({
  id: `history:${index}`,
  level: "info",
  message,
  timestamp: `09:${String(20 + index).padStart(2, "0")}:00`,
}));

export default defineStories({
  component: "Log",
  description:
    "Recent log lines coloured by level, with a position and follow footer.",
  title: "UI/Log",
});

export const Levels = story({
  description: "One line at each level, in its level colour.",
  name: "Levels",
  render: (renderer) =>
    renderFrame(renderer, <Log entries={levels} focused={false} />, size),
});

export const ScrollAndFollow = story({
  description:
    "More lines than fit; arrows scroll and f toggles following the newest line.",
  name: "Scroll and follow",
  render: (renderer) =>
    renderFrame(renderer, <Log entries={history} focused />, size),
});

export const ShortWindow = story({
  description: "A three-line window over a longer log.",
  name: "Short window",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Log entries={history} focused={false} height={3} />,
      size
    ),
});

export const Empty = story({
  description: "No entries yet.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(renderer, <Log entries={[]} focused={false} />, size),
});

export const Narrow = story({
  description: "Long lines wrap in a narrow log.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <Log entries={levels} focused={false} />, {
      height: 12,
      width: 32,
    }),
});
