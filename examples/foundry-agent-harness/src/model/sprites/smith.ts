import type { SpriteSheet } from "@/model/sprite";

export const smith: SpriteSheet = {
  cell: 256,
  file: "smith.png",
  poses: ["smirk", "blink", "left", "right", "wince"],
  still: { smirk: ["scuffed", "hurt", "battered", "critical"] },
};
