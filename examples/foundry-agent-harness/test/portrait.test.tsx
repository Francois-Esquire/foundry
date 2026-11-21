import { act, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { useWound } from "../src/hooks/use-wound";
import { type Avatar, avatars } from "../src/model/avatars";
import { HURT_TICKS, halfBlocks, portrait } from "../src/model/portrait";
import {
  HEALTH,
  type Health,
  healthAt,
  POSES,
  SPRITE_SIZE,
} from "../src/model/sprite";
import { frameWith, mount, unmount } from "./helpers/render";

const DIGITS = "0123456789abcdefghijklmnopqrstuv";
const COLOUR = /^#[0-9a-f]{6}$/;
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

afterEach(async () => {
  wound = undefined;
  move = undefined;
  await unmount();
});

describe.each(everyAvatar)("$name", (avatar) => {
  test("has a full palette and a square sprite for every health", () => {
    expect(avatar.sheet.palette).toHaveLength(DIGITS.length);
    for (const health of HEALTH) {
      const rows = avatar.sheet.states[health];
      expect(rows).toHaveLength(SPRITE_SIZE);
      for (const row of rows) {
        expect(row).toMatch(new RegExp(`^[${DIGITS}]{${SPRITE_SIZE}}$`));
      }
    }
  });

  test("has a patch for every health in every pose it uses", () => {
    const used = [...avatar.hurt.flat(), avatar.flicker ?? "blink", "blink"];
    for (const pose of POSES) {
      const patches = avatar.sheet.poses[pose];
      expect(patches !== undefined || !used.includes(pose)).toBe(true);
      for (const health of HEALTH) {
        const patch = patches?.[health] ?? "";
        expect(patch.length % 3).toBe(0);
        expect(patch).toMatch(new RegExp(`^[${DIGITS}]*$`));
      }
    }
  });

  test("draws every pixel in a real colour, the same way each time", () => {
    for (const health of HEALTH) {
      for (let frame = 0; frame < 120; frame += 1) {
        const moment = { avatar, frame, health, hurtAt: HIT_AT, seed: 7 };
        const pixels = portrait(moment);
        expect(pixels).toHaveLength(SPRITE_SIZE);
        expect(pixels.flat()).toHaveLength(SPRITE_SIZE * SPRITE_SIZE);
        expect(pixels.flat().every((colour) => COLOUR.test(colour))).toBe(true);
        expect(portrait(moment)).toEqual(pixels);
      }
    }
  });

  test("moves while idle and differs by seed", () => {
    const frames = (seed: number) =>
      Array.from({ length: 200 }, (_, frame) =>
        portrait({ avatar, frame, health: "fresh", hurtAt: null, seed }).join()
      );
    expect(new Set(frames(1)).size).toBeGreaterThan(2);
    expect(frames(1)).not.toEqual(frames(2));
  });

  test("reacts to a hit for the hurt window and then recovers", () => {
    const at = (frame: number, hurtAt: number | null) =>
      portrait({ avatar, frame, health: "hurt", hurtAt, seed: 3 });
    for (let since = 0; since < HURT_TICKS; since += 1) {
      expect(at(HIT_AT + since, HIT_AT)).not.toEqual(at(HIT_AT + since, null));
    }
    expect(at(HIT_AT - 1, HIT_AT)).toEqual(at(HIT_AT - 1, null));
    expect(at(HIT_AT + HURT_TICKS, HIT_AT)).toEqual(
      at(HIT_AT + HURT_TICKS, null)
    );
  });
});

test("half blocks cover every pixel in runs of equal cells", () => {
  const [avatar] = avatars;
  const pixels = portrait({
    avatar,
    frame: 0,
    health: "critical",
    hurtAt: null,
    seed: 1,
  });
  const lines = halfBlocks(pixels);
  expect(lines).toHaveLength(SPRITE_SIZE / 2);
  lines.forEach((line, row) => {
    expect(line.flatMap((run) => new Array(run.cells).fill(run.top))).toEqual(
      pixels[row * 2]
    );
    expect(
      line.flatMap((run) => new Array(run.cells).fill(run.bottom))
    ).toEqual(pixels[row * 2 + 1]);
  });
  expect(lines.flat().length).toBeLessThan((SPRITE_SIZE * SPRITE_SIZE) / 2);
});

test("health falls as the context fills", () => {
  expect([0, 0.2, 0.3, 0.5, 0.7, 0.9, 1].map(healthAt)).toEqual([
    "fresh",
    "fresh",
    "scuffed",
    "hurt",
    "battered",
    "critical",
    "critical",
  ]);
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
