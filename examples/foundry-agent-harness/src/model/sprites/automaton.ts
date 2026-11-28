import type { SpriteSheet } from "@/model/sprite";

export const automaton: SpriteSheet = {
  cell: 256,
  file: "automaton.png",
  poses: ["blink", "left", "right", "glow"],
  still: { left: ["fresh", "hurt", "critical"], right: ["hurt", "critical"] },
};
