export interface Tone {
  readonly deep: string;
  readonly dim: string;
  readonly glow: string;
  readonly lit: string;
}

export const hud = {
  amber: "#f2a52e",
  brass: ["#241a07", "#553d12", "#8c6a26", "#c2953c", "#efcd78"],
  dim: "#8e8a80",
  grain: ["#383a3c", "#3e4042", "#444648"],
  iron: [
    "#060607",
    "#131415",
    "#222426",
    "#3e4042",
    "#5a5d60",
    "#8b9094",
    "#c3c7c9",
  ],
  lift: ["#46484a", "#4c4e50", "#525456"],
  ok: "#8fe05a",
  red: "#ef5a3c",
  screen: "#0d0c0a",
  shade: "#040403",
  slab: "#1b1b1a",
  sunk: ["#2c2e30", "#313335", "#36383a"],
  text: "#ebe5d3",
} as const;

export const tones = {
  amber: { deep: "#3d2607", dim: "#8f5f14", glow: "#ffd98a", lit: "#f2a52e" },
  green: { deep: "#14290d", dim: "#3f7a22", glow: "#c9f59e", lit: "#74d43f" },
  red: { deep: "#3a100a", dim: "#8a2a1a", glow: "#ff9c80", lit: "#e8492d" },
  steel: { deep: "#222426", dim: "#5a5d60", glow: "#c3c7c9", lit: "#8b9094" },
} as const satisfies Record<string, Tone>;

export type ToneName = keyof typeof tones;
