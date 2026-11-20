import { defineStories, story } from "textbook-sh";
import { StatusLabel } from "~/components/blocks/status-label";
import { Text } from "~/components/ui/text";
import {
  type InputAttention,
  type RunStatus,
  statusDisplay,
} from "~/model/run-status";
import { renderFrame } from "../frame";

const size = { height: 5, width: 40 };

const statuses: readonly RunStatus[] = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "suspended",
  "paused",
  "skipped",
];

const attentions: readonly InputAttention[] = ["approval", "question"];

function Labelled({ status }: { readonly status: RunStatus }) {
  return (
    <box flexDirection="row" gap={1}>
      <Text>{status.padEnd(10)}</Text>
      <StatusLabel status={statusDisplay({ status })} />
    </box>
  );
}

export default defineStories({
  component: "StatusLabel",
  description:
    "A run status in its tone's colour; warnings and errors are badges.",
  title: "Blocks/StatusLabel",
});

export const EveryStatus = story({
  description:
    "Every run status and both input waits, labelled as the run list shows them.",
  name: "Every status",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="column">
        {statuses.map((status) => (
          <Labelled key={status} status={status} />
        ))}
        {attentions.map((attention) => (
          <box flexDirection="row" gap={1} key={attention}>
            <Text>{attention.padEnd(10)}</Text>
            <StatusLabel
              status={statusDisplay({ attention, status: "suspended" })}
            />
          </box>
        ))}
      </box>,
      { height: 14, width: 40 }
    ),
});

export const Neutral = story({
  description: "The neutral tone in muted text, used for queued and paused.",
  name: "Neutral",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLabel status={statusDisplay({ status: "queued" })} />,
      size
    ),
});

export const Info = story({
  description: "The info tone, used while a run is running.",
  name: "Info",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLabel status={statusDisplay({ status: "running" })} />,
      size
    ),
});

export const Success = story({
  description: "The success tone, used for a complete run.",
  name: "Success",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLabel status={statusDisplay({ status: "complete" })} />,
      size
    ),
});

export const Warning = story({
  description: "The warning badge, shown while a run waits for approval.",
  name: "Warning",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLabel
        status={statusDisplay({ attention: "approval", status: "suspended" })}
      />,
      size
    ),
});

export const ErrorTone = story({
  description: "The error badge, used for a failed run.",
  name: "Error",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatusLabel status={statusDisplay({ status: "failed" })} />,
      size
    ),
});
