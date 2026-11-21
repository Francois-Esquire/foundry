import type { Theme } from "@/components/ui/types";
import { defaultTheme } from "@/lib/terminal-themes/default";
import { hud } from "@/model/palette";

export const amberTheme: Theme = {
  ...defaultTheme,
  border: { ...defaultTheme.border, color: hud.bronze, focusColor: hud.amber },
  colors: {
    ...defaultTheme.colors,
    accent: hud.bright,
    background: hud.ink,
    border: hud.bronze,
    error: hud.red,
    focusRing: hud.amber,
    foreground: hud.text,
    info: hud.bright,
    muted: hud.trough,
    mutedForeground: hud.dim,
    primary: hud.amber,
    primaryForeground: hud.ink,
    secondary: hud.bronze,
    selection: hud.amber,
    selectionForeground: hud.ink,
    success: hud.ok,
    warning: hud.amber,
  },
  name: "amber",
};
