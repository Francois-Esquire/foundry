import pc from "picocolors";

import type { Tone } from "./views";

type Style = (text: string) => string;

/** Semantic styles. Color is emphasis, never meaning; plain is all identity. */
export interface RenderTheme {
  anchored: Style;
  blocked: Style;
  caution: Style;
  emphasis: Style;
  heading: Style;
  muted: Style;
}

const identity: Style = (text) => text;

export const plainTheme: RenderTheme = {
  anchored: identity,
  blocked: identity,
  caution: identity,
  emphasis: identity,
  heading: identity,
  muted: identity,
};

/** Forced on so output is deterministic; the context decides whether to use it. */
export function colorTheme(): RenderTheme {
  const colors = pc.createColors(true);
  return {
    anchored: colors.dim,
    blocked: colors.red,
    caution: colors.yellow,
    emphasis: colors.bold,
    heading: colors.bold,
    muted: colors.dim,
  };
}

export function toneStyle(theme: RenderTheme, tone: Tone): Style {
  switch (tone) {
    case "neutral":
      return identity;
    case "emphasis":
      return theme.emphasis;
    case "caution":
      return theme.caution;
    case "blocked":
      return theme.blocked;
    case "anchored":
      return theme.anchored;
    default:
      throw new Error("Unexpected tone.");
  }
}

export interface Glyphs {
  anchored: string;
  blocked: string;
  box: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
  };
  bullet: string;
  caution: string;
  empty: string;
  fail: string;
  fill: string;
  flow: string;
  overflow: string;
  pass: string;
  rule: string;
  signal: string;
}

const unicodeGlyphs: Glyphs = {
  anchored: "◆",
  blocked: "■",
  box: {
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    topLeft: "┌",
    topRight: "┐",
    vertical: "│",
  },
  bullet: "•",
  caution: "△",
  empty: "░",
  fail: "✕",
  fill: "█",
  flow: "→",
  overflow: "…",
  pass: "✓",
  rule: "═",
  signal: "◇",
};

const asciiGlyphs: Glyphs = {
  anchored: "[anchor]",
  blocked: "[x]",
  box: {
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    topLeft: "+",
    topRight: "+",
    vertical: "|",
  },
  bullet: "-",
  caution: "!",
  empty: "-",
  fail: "--",
  fill: "#",
  flow: "->",
  overflow: "...",
  pass: "ok",
  rule: "=",
  signal: "*",
};

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode ? unicodeGlyphs : asciiGlyphs;
}

export function toneGlyph(glyphs: Glyphs, tone: Tone): string {
  switch (tone) {
    case "neutral":
    case "emphasis":
      return glyphs.signal;
    case "caution":
      return glyphs.caution;
    case "blocked":
      return glyphs.blocked;
    case "anchored":
      return glyphs.anchored;
    default:
      throw new Error("Unexpected tone.");
  }
}
