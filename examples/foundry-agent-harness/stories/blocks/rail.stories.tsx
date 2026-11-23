import { defineStories, story } from "textbook-sh";
import { Arsenal } from "@/components/blocks/arsenal";
import { Loadout } from "@/components/blocks/loadout";
import { Plate } from "@/components/blocks/plate";
import { Toolkit } from "@/components/blocks/toolkit";
import { totalsLine, Vitals } from "@/components/blocks/vitals";
import { slotsOf } from "@/model/context";
import { hud } from "@/model/palette";
import { stepsOf, toolTallies } from "@/model/thread";
import { clock, context, progress, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 10, width: 38 };

export default defineStories({
  component: "Plate",
  description:
    "The cards on the status rail: vitals, the loadout, the toolkit and the arsenal.",
  title: "Blocks/Rail",
});

export const Healthy = story({
  description: "Most of the context window is still free.",
  name: "Vitals, fresh",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate
        icon="♥"
        meta={totalsLine({ input: 18_400, output: 912 })}
        title="VITALS"
      >
        <Vitals
          health="fresh"
          limit={200_000}
          progress={progress.fresh}
          tokens={182_000}
          used={0.09}
        />
      </Plate>,
      size
    ),
});

export const Spent = story({
  description: "The context window is nearly full.",
  name: "Vitals, critical",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate
        icon="♥"
        meta={totalsLine({ input: 412_000, output: 9100 })}
        title="VITALS"
      >
        <Vitals
          health="critical"
          limit={200_000}
          progress={progress.fresh}
          tokens={14_000}
          used={0.93}
        />
      </Plate>,
      size
    ),
});

export const Model = story({
  description: "Up and Down swap the model.",
  name: "Loadout, model focused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="⌖" meta="claude-code" title="LOADOUT" tone={hud.amber}>
        <Loadout
          effort="medium"
          focus="model"
          model="sonnet"
          models={context.models}
        />
      </Plate>,
      size
    ),
});

export const Effort = story({
  description: "Up raises the effort and Down lowers it.",
  name: "Loadout, effort focused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="⌖" meta="claude-code" title="LOADOUT" tone={hud.amber}>
        <Loadout
          effort="high"
          focus="effort"
          model="opus"
          models={context.models}
        />
      </Plate>,
      size
    ),
});

export const Slots = story({
  description: "Skills and MCP servers, with the chosen one explained.",
  name: "Tools",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="◧" meta="2 equipped" title="TOOLS" tone={hud.amber}>
        <Toolkit focused selected={1} slots={slotsOf(context)} />
      </Plate>,
      size
    ),
});

export const Fired = story({
  description: "Each tool used so far, with one still running.",
  name: "Arsenal",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="⚒" meta="3 calls" title="ARSENAL">
        <Arsenal
          frame={clock.frame}
          tallies={toolTallies(stepsOf(threads.working))}
        />
      </Plate>,
      size
    ),
});

export const Quiet = story({
  description: "Before any tool has run.",
  name: "Arsenal, empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="⚒" meta="0 calls" title="ARSENAL">
        <Arsenal frame={clock.frame} tallies={[]} />
      </Plate>,
      size
    ),
});

export const Levelled = story({
  description:
    "Four accepted encounters later: level 4 and part of the way to 5.",
  name: "Vitals, level 4",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate
        icon="♥"
        meta={totalsLine({ input: 73_600, output: 3648 })}
        title="VITALS"
      >
        <Vitals
          health="fresh"
          limit={200_000}
          progress={progress.seasoned}
          tokens={193_875}
          used={0.03}
        />
      </Plate>,
      size
    ),
});
