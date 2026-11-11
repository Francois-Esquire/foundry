/**
 * Whether the browser can set text in a registered source font yet. Text is
 * only set in a family once its font has loaded: before that, or when the
 * browser refuses the file, CSS would silently fall back to a system font.
 */
import { useSettled } from "~/lib/use-settled";

export type FontStatus = "loaded" | "loading" | "unavailable";

/** The part of a FontFace this module reads. */
export interface RegisteredFont {
  readonly family: string;
  readonly loaded: Promise<unknown>;
}

const QUOTES = /^["']|["']$/g;

/** Browsers disagree on whether a family name comes back quoted. */
export const findRegisteredFont = <Font extends RegisteredFont>(
  fonts: Iterable<Font>,
  family: string
): Font | undefined => {
  for (const font of fonts) {
    if (font.family.replace(QUOTES, "") === family) {
      return font;
    }
  }
};

const registeredFonts = (): Iterable<FontFace> =>
  typeof document === "undefined" || !document.fonts ? [] : document.fonts;

/** Settles when the browser has loaded the font, and rejects when it will not. */
const whenLoaded = async (font: FontFace | undefined) => {
  await font?.loaded;
};

/**
 * Follows one family until its font has loaded or failed. No family, or a
 * family the browser has no font for, is unavailable.
 */
export const useFontStatus = (family: string | undefined): FontStatus => {
  const font =
    family === undefined
      ? undefined
      : findRegisteredFont(registeredFonts(), family);
  const settled = useSettled(font, whenLoaded);
  if (!font) {
    return "unavailable";
  }
  if (settled?.key !== font) {
    return "loading";
  }
  return "error" in settled ? "unavailable" : "loaded";
};
