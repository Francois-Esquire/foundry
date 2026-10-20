import type { LabelFace, LabelFont, TextMeasure } from "../../layout/labels";

/** Each face as CSS asks for it, with the fallback the page declares. */
const families: Record<LabelFace, string> = {
  Georgia: "Georgia, serif",
  SpyglassBody: "SpyglassBody, sans-serif",
  SpyglassDisplay: "SpyglassDisplay, serif",
};

/** The font-family a label is set in. */
export function fontFamily(font: LabelFont): string {
  return families[font.face];
}

/** The size everything is measured at: widths and baselines scale with the size, so one measure serves every zoom. */
const canonicalSize = 100;

/** The browser's measure of text: widths in em, and where each face's baseline falls in a line of its own height. */
export interface TextMetrics {
  /** How far below the top of a line set at `line-height: 1` the baseline lies, in em, for a font. */
  baseline: (font: LabelFont) => number;
  dispose: () => void;
  measure: TextMeasure;
}

function fontKey(font: LabelFont): string {
  return `${font.face}|${font.italic ? "italic" : "normal"}|${font.letterSpacing ?? 0}`;
}

/**
 * Measures text as the browser will set it: a hidden element in the labels'
 * root, set at the canonical size in the font, read once per text and font
 * and kept. Widths agree with the lettering, since the same engine lays out
 * both; the baseline is read from an empty inline block, whose bottom sits
 * on it. Both reads force a layout, so the layer measures before it writes.
 */
export function createTextMetrics(root: HTMLElement): TextMetrics {
  const probe = document.createElement("span");
  probe.className = "spyglass-measure";
  probe.setAttribute("aria-hidden", "true");
  root.append(probe);
  const marker = document.createElement("span");
  marker.className = "spyglass-measure-baseline";
  const widths = new Map<string, number>();
  const baselines = new Map<string, number>();
  const set = (font: LabelFont) => {
    probe.style.fontFamily = fontFamily(font);
    probe.style.fontStyle = font.italic ? "italic" : "normal";
    probe.style.fontSize = `${canonicalSize}px`;
    probe.style.letterSpacing = `${font.letterSpacing ?? 0}em`;
  };
  return {
    baseline(font) {
      const key = fontKey(font);
      let baseline = baselines.get(key);
      if (baseline === undefined) {
        set(font);
        probe.textContent = "Hg";
        probe.append(marker);
        baseline =
          (marker.getBoundingClientRect().bottom -
            probe.getBoundingClientRect().top) /
          canonicalSize;
        marker.remove();
        baselines.set(key, baseline);
      }
      return baseline;
    },
    dispose() {
      probe.remove();
    },
    measure(text, font) {
      const key = `${fontKey(font)}|${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        set(font);
        probe.textContent = text;
        width = probe.getBoundingClientRect().width / canonicalSize;
        widths.set(key, width);
      }
      return width;
    },
  };
}
