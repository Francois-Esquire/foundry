import type { Pose, SpriteSheet } from "@/model/sprite";
import { assayer } from "@/model/sprites/assayer";
import { automaton } from "@/model/sprites/automaton";
import { caster } from "@/model/sprites/caster";
import { fitter } from "@/model/sprites/fitter";
import { machinist } from "@/model/sprites/machinist";
import { rigger } from "@/model/sprites/rigger";
import { smith } from "@/model/sprites/smith";
import { stoker } from "@/model/sprites/stoker";
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
  readonly rest?: Pose;
  readonly sheet: SpriteSheet;
  readonly steady?: readonly Pose[];
  readonly wound: Wound;
}

const flesh: Wound = { bottom: 18, spread: 8, style: "blood", top: 12 };

export const avatars = [
  {
    hurt: [["wince"]],
    name: "Smith",
    rest: "smirk",
    sheet: smith,
    wound: flesh,
  },
  {
    hurt: [["wince"]],
    name: "Welder",
    sheet: welder,
    steady: ["left"],
    wound: flesh,
  },
  { hurt: [["wince"]], name: "Caster", sheet: caster, wound: flesh },
  { hurt: [["wince"]], name: "Machinist", sheet: machinist, wound: flesh },
  { hurt: [["wince"]], name: "Rigger", sheet: rigger, wound: flesh },
  { hurt: [["wince"]], name: "Assayer", sheet: assayer, wound: flesh },
  { hurt: [["wince"]], name: "Stoker", sheet: stoker, wound: flesh },
  { hurt: [], name: "Fitter", sheet: fitter, wound: flesh },
  {
    flicker: "glow",
    hurt: [["glow", "blink"], ["glow"]],
    name: "Automaton",
    sheet: automaton,
    wound: { rows: [13, 23], spread: 14, style: "sparks" },
  },
] as const satisfies readonly Avatar[];
