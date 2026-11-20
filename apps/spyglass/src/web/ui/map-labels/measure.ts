import type { LabelFace, LabelFont, TextMeasure } from "../../layout/labels";

const families: Record<LabelFace, string> = {
  Georgia: "Georgia, serif",
  SpyglassBody: "SpyglassBody, sans-serif",
  SpyglassDisplay: "SpyglassDisplay, serif",
};

export function fontFamily(font: LabelFont): string {
  return families[font.face];
}

const canonicalSize = 100;

export interface TextMetrics {
  baseline: (font: LabelFont) => number;
  dispose: () => void;
  measure: TextMeasure;
}

function fontKey(font: LabelFont): string {
  return `${font.face}|${font.italic ? "italic" : "normal"}|${font.letterSpacing}`;
}

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
    probe.style.letterSpacing = `${font.letterSpacing}em`;
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
