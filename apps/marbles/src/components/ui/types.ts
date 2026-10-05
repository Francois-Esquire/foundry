// Adapted from termcn.
export type BorderStyle = "single" | "double" | "rounded" | "heavy";

interface ColorTokens {
  accent: string;
  accentForeground: string;
  background: string;
  border: string;
  error: string;
  errorForeground: string;
  focusRing: string;
  foreground: string;
  info: string;
  infoForeground: string;
  muted: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  selection: string;
  selectionForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
}

interface SpacingTokens {
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
  6: number;
  8: number;
}

interface TypographyTokens {
  base: string;
  bold: boolean;
  lg: string;
  sm: string;
  xl: string;
}

interface BorderTokens {
  color: string;
  focusColor: string;
  style: BorderStyle;
}

export interface Theme {
  border: BorderTokens;
  colors: ColorTokens;
  name: string;
  spacing: SpacingTokens;
  typography: TypographyTokens;
}
