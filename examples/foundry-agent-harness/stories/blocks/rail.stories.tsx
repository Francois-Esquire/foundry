import { defineStories, story } from "textbook-sh";
import { Arsenal } from "@/components/blocks/arsenal";
import { Loadout } from "@/components/blocks/loadout";
import { Plate } from "@/components/blocks/plate";
import { Vitals } from "@/components/blocks/vitals";
import { Weapon } from "@/components/blocks/weapon";
import { slotsOf } from "@/model/context";
import { hud } from "@/model/palette";
import { toolTallies } from "@/model/thread";
import { clock, context, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 10, width: 38 };

export default defineStories({
  component: "Plate",
  description:
    "The cards on the status rail: vitals, the weapon, the loadout and the arsenal.",
  title: "Blocks/Rail",
});

export const Healthy = story({
  description: "Most of the context window is still free.",
  name: "Vitals, fresh",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="♥" meta="9% used" title="VITALS">
        <Vitals
          health="fresh"
          input={18_400}
          limit={200_000}
          output={912}
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
      <Plate icon="♥" meta="93% used" title="VITALS">
        <Vitals
          health="critical"
          input={412_000}
          limit={200_000}
          output={9100}
          tokens={14_000}
          used={0.93}
        />
      </Plate>,
      size
    ),
});

export const Gun = story({
  description: "The model is the gun; Up and Down swap it.",
  name: "Weapon, gun focused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="⌖" meta="claude-code" title="WEAPON" tone={hud.amber}>
        <Weapon
          effort="medium"
          focus="model"
          model="sonnet"
          models={context.models}
        />
      </Plate>,
      size
    ),
});

export const Ammo = story({
  description: "Effort is the ammo; Up loads a round and Down drops one.",
  name: "Weapon, ammo focused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="⌖" meta="claude-code" title="WEAPON" tone={hud.amber}>
        <Weapon
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
  name: "Loadout",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Plate icon="◧" meta="2 equipped" title="LOADOUT" tone={hud.amber}>
        <Loadout focused selected={1} slots={slotsOf(context)} />
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
        <Arsenal frame={clock.frame} tallies={toolTallies(threads.working)} />
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
