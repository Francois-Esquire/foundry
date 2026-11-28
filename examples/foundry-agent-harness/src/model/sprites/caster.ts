import type { SpriteSheet } from "@/model/sprite";

export const caster: SpriteSheet = {
  cell: 256,
  file: "caster.png",
  poses: ["blink", "wince"],
  still: { blink: ["critical"] },
};
