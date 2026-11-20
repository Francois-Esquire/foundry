import { defineStories, story } from "textbook-sh";
import { KindBadge } from "~/components/blocks/kind-badge";
import type { ItemKind } from "~/model/dashboard";
import { renderFrame } from "../frame";

const kinds: readonly ItemKind[] = ["workflow", "step", "schedule", "monitor"];

const size = { height: 3, width: 20 };

export default defineStories({
  component: "KindBadge",
  description: "A coloured tag naming what kind of catalog item a row is.",
  title: "Blocks/KindBadge",
});

export const AllKinds = story({
  description: "Every kind side by side, each in its own colour.",
  name: "All kinds",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="row" gap={1}>
        {kinds.map((kind) => (
          <KindBadge key={kind} kind={kind} />
        ))}
      </box>,
      { height: 3, width: 48 }
    ),
});

export const Workflow = story({
  description: "A workflow, in the primary colour.",
  name: "Workflow",
  render: (renderer) =>
    renderFrame(renderer, <KindBadge kind="workflow" />, size),
});

export const Step = story({
  description: "A standalone step, in the secondary colour.",
  name: "Step",
  render: (renderer) => renderFrame(renderer, <KindBadge kind="step" />, size),
});

export const Schedule = story({
  description: "A schedule trigger, in the info colour.",
  name: "Schedule",
  render: (renderer) =>
    renderFrame(renderer, <KindBadge kind="schedule" />, size),
});

export const Monitor = story({
  description: "A monitor trigger, in the warning colour.",
  name: "Monitor",
  render: (renderer) =>
    renderFrame(renderer, <KindBadge kind="monitor" />, size),
});
