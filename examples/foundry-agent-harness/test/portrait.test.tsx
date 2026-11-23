import { act, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { Portrait } from "../src/components/blocks/portrait";
import { portraitImage, usePortrait } from "../src/hooks/use-portrait";
import { useWound } from "../src/hooks/use-wound";
import { type Avatar, avatars } from "../src/model/avatars";
import {
  HURT_TICKS,
  type PortraitMoment,
  paintPortrait,
  portraitScene,
} from "../src/model/portrait";
import { HEALTH, type Health } from "../src/model/sprite";
import { frameWith, mount, unmount } from "./helpers/render";

const HIT_AT = 40;
const everyAvatar: readonly Avatar[] = avatars;

let wound: ReturnType<typeof useWound> | undefined;
let move: ((frame: number, health: Health) => void) | undefined;

function WoundProbe() {
  const [at, setAt] = useState<{ frame: number; health: Health }>({
    frame: 5,
    health: "fresh",
  });
  move = (frame, health) => setAt({ frame, health });
  wound = useWound(at.health, at.frame);
  return <text>{`hurt at ${wound.hurtAt}`}</text>;
}

function PortraitProbe(moment: PortraitMoment) {
  const image = usePortrait(moment);
  return (
    <box flexDirection="column">
      <text>{image ? `loaded ${image.width}` : "loading"}</text>
      <Portrait image={image} />
    </box>
  );
}

async function pixelsOf(moment: PortraitMoment): Promise<number[]> {
  const image = await portraitImage(moment);
  try {
    return [...image.raw("rgba8").data];
  } finally {
    image.dispose();
  }
}

afterEach(async () => {
  wound = undefined;
  move = undefined;
  await unmount();
});

describe.each(everyAvatar)("$name", (avatar) => {
  const at = (frame: number, hurtAt: number | null, health: Health = "hurt") =>
    portraitScene({ avatar, frame, health, hurtAt, seed: 3 });

  test("only strikes poses its sheet has", () => {
    for (const pose of avatar.hurt.flat()) {
      expect(avatar.sheet.poses).toContain(pose);
    }
    for (const health of HEALTH) {
      for (let frame = 0; frame < 400; frame += 1) {
        for (const pose of at(frame, HIT_AT, health).poses) {
          expect(avatar.sheet.poses).toContain(pose);
          expect(avatar.sheet.still[pose] ?? []).not.toContain(health);
          expect(avatar.steady ?? []).not.toContain(pose);
        }
      }
    }
  });

  test("moves while idle, the same way each time, and differs by seed", () => {
    const scenes = (seed: number) =>
      Array.from({ length: 200 }, (_, frame) =>
        JSON.stringify(
          portraitScene({ avatar, frame, health: "fresh", hurtAt: null, seed })
        )
      );
    expect(new Set(scenes(1)).size).toBeGreaterThan(2);
    expect(scenes(1)).toEqual(scenes(1));
    expect(scenes(1)).not.toEqual(scenes(2));
  });

  test("reacts to a hit for the hurt window and then recovers", () => {
    for (let since = 0; since < HURT_TICKS; since += 1) {
      expect(at(HIT_AT + since, HIT_AT)).not.toEqual(at(HIT_AT + since, null));
    }
    expect(at(HIT_AT, HIT_AT).flash).toBe(true);
    expect(at(HIT_AT, HIT_AT).shake).not.toBe(0);
    expect(at(HIT_AT - 1, HIT_AT)).toEqual(at(HIT_AT - 1, null));
    expect(at(HIT_AT + HURT_TICKS, HIT_AT)).toEqual(
      at(HIT_AT + HURT_TICKS, null)
    );
  });

  test("paints a full opaque picture that a hit changes", async () => {
    const { cell } = avatar.sheet;
    const moment = {
      avatar,
      frame: HIT_AT + 3,
      health: "hurt",
      seed: 3,
    } as const;
    const calm = await pixelsOf({ ...moment, hurtAt: null });
    const struck = await pixelsOf({ ...moment, hurtAt: HIT_AT });
    expect(calm).toHaveLength(cell * cell * 4);
    expect(calm.filter((_, index) => index % 4 === 3)).toEqual(
      new Array(cell * cell).fill(255)
    );
    expect(struck).not.toEqual(calm);
  });
});

test("a pose the sheet lacks leaves the picture alone", () => {
  const [avatar] = avatars;
  const { cell } = avatar.sheet;
  const atlas = new Uint8Array(
    HEALTH.length * cell * (avatar.sheet.poses.length + 1) * cell * 4
  ).fill(200);
  const scene = { dots: [], flash: false, health: "fresh", shake: 0 } as const;
  expect(
    paintPortrait(avatar.sheet, atlas, { ...scene, poses: ["glow"] })
  ).toEqual(paintPortrait(avatar.sheet, atlas, { ...scene, poses: [] }));
});

test("a portrait loads its picture and draws it", async () => {
  const [avatar] = avatars;
  const ui = await mount(
    <PortraitProbe
      avatar={avatar}
      frame={0}
      health="fresh"
      hurtAt={null}
      seed={1}
    />
  );
  const frame = await frameWith(ui, "loaded 256");
  expect(frame).toContain("loaded 256");
  expect(frame).not.toContain("· · ·");
});

test("a wound opens when health worsens, not when it recovers", async () => {
  const ui = await mount(<WoundProbe />);
  expect(await frameWith(ui, "hurt at null")).toContain("hurt at null");

  await act(async () => move?.(12, "hurt"));
  expect(await frameWith(ui, "hurt at 12")).toContain("hurt at 12");

  await act(async () => move?.(30, "scuffed"));
  await act(async () => move?.(31, "scuffed"));
  expect(await frameWith(ui, "hurt at 12")).toContain("hurt at 12");

  await act(async () => wound?.hit());
  expect(await frameWith(ui, "hurt at 31")).toContain("hurt at 31");
});

test("the Smith rests on a smirk, smiles now and then, and drops it once hurt", () => {
  const [smith] = avatars;
  const smirks = (health: Health) =>
    Array.from({ length: 3000 }, (_, frame) =>
      portraitScene({ avatar: smith, frame, health, hurtAt: null, seed: 1 })
    ).filter((scene) => scene.poses.includes("smirk")).length / 3000;

  expect(smirks("fresh")).toBeGreaterThan(0.6);
  expect(smirks("fresh")).toBeLessThan(0.95);
  expect(smirks("hurt")).toBe(0);
});
