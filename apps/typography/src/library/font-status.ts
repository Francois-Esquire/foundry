/**
 * Whether the browser can set text in a registered source font yet. Text is
 * only set in a family once its font has loaded: before that, or when the
 * browser refuses the file, CSS would silently fall back to a system font.
 */
import { useEffect, useState } from "react";

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

interface Settled {
  readonly family: string;
  readonly status: FontStatus;
}

const registeredFonts = (): Iterable<FontFace> =>
  typeof document === "undefined" || !document.fonts ? [] : document.fonts;

/** Follows one family until its font has loaded or failed. No family is unavailable. */
export const useFontStatus = (family: string | undefined): FontStatus => {
  const [settled, setSettled] = useState<Settled>();
  useEffect(() => {
    if (family === undefined) {
      return;
    }
    let current = true;
    const settle = (status: FontStatus) => {
      if (current) {
        setSettled({ family, status });
      }
    };
    const font = findRegisteredFont(registeredFonts(), family);
    if (font) {
      font.loaded.then(
        () => settle("loaded"),
        () => settle("unavailable")
      );
    } else {
      settle("unavailable");
    }
    return () => {
      current = false;
    };
  }, [family]);
  if (family === undefined) {
    return "unavailable";
  }
  return settled?.family === family ? settled.status : "loading";
};
