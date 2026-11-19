import termcnThemes from "./termcn-themes.json";

type TermcnThemeName = keyof typeof termcnThemes;
export type ThemeName = "dark" | "light" | TermcnThemeName;

export const THEME_NAMES: readonly ThemeName[] = [
  "dark",
  "light",
  ...(Object.keys(termcnThemes) as TermcnThemeName[]),
];

export function isTheme(value: unknown): value is ThemeName {
  return (
    typeof value === "string" &&
    (value === "dark" ||
      value === "light" ||
      Object.hasOwn(termcnThemes, value))
  );
}

export function themeLabel(name: ThemeName): string {
  if (name === "dark" || name === "light") {
    return name === "dark" ? "Dark" : "Light";
  }
  return termcnThemes[name].label;
}

export interface SettingsSnapshot {
  readonly path: string;
  readonly problem?: string;
  readonly theme: ThemeName;
}

export interface SettingsChange {
  readonly theme?: ThemeName;
}
