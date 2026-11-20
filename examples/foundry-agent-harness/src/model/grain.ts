import { hud } from "@/model/palette";

function noise(x: number, y: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function pick(tones: readonly [string, string, string], x: number, y: number) {
  const value = noise(x, y);
  if (value < 0.09) {
    return tones[0];
  }
  return value > 0.94 ? tones[2] : tones[1];
}

export function grain(x: number, y: number): string {
  return pick(hud.grain, x, y);
}

export function lifted(x: number, y: number): string {
  return pick(hud.lift, x, y);
}

export function sunken(x: number, y: number): string {
  return pick(hud.sunk, x, y);
}
