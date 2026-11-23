import type { Pose, SpriteSheet } from "@/model/sprite";
import { automaton } from "@/model/sprites/automaton";
import { smith } from "@/model/sprites/smith";
import { welder } from "@/model/sprites/welder";

export type Wound =
  | {
      readonly bottom: number;
      readonly spread: number;
      readonly style: "blood";
      readonly top: number;
    }
  | {
      readonly rows: readonly number[];
      readonly spread: number;
      readonly style: "sparks";
    };

export interface Avatar {
  readonly flicker?: Pose;
  readonly hurt: readonly (readonly Pose[])[];
  readonly name: string;
  readonly sheet: SpriteSheet;
  readonly steady?: readonly Pose[];
  readonly wound: Wound;
}

const flesh: Wound = { bottom: 18, spread: 8, style: "blood", top: 12 };

export const avatars = [
  { hurt: [["wince"]], name: "Smith", sheet: smith, wound: flesh },
  {
    hurt: [["wince"]],
    name: "Welder",
    sheet: welder,
    steady: ["left"],
    wound: flesh,
  },
  {
    flicker: "glow",
    hurt: [["glow", "blink"], ["glow"]],
    name: "Automaton",
    sheet: automaton,
    wound: { rows: [13, 23], spread: 14, style: "sparks" },
  },
] as const satisfies readonly Avatar[];
