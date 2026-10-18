import type { Territory } from "../data/types";
import type { InkView } from "./chart-view";

export function fileInView(
  territory: Territory | undefined,
  fileId: string | undefined,
  view: InkView
) {
  const file = territory?.files.find((item) => item.id === fileId);
  return (
    !!territory &&
    !!file &&
    Math.abs(territory.x + file.x - view.x) <= view.width / 2 &&
    Math.abs(territory.y + file.y - view.y) <= view.height / 2
  );
}

const fade = (value: number, start: number, end: number) =>
  Math.max(0, Math.min(1, (value - start) / (end - start)));

export function detailLevel(pixels: number, hasComposition = false) {
  const regionIntro = fade(pixels, 1.2, 1.8);
  const files = fade(pixels, 3, 5);
  const composition = hasComposition ? fade(pixels, 6, 8) : 0;
  return {
    composition,
    districts: regionIntro * (1 - files),
    files,
    /** The latitude scale, a margin note for the whole spyglass, gives way as an island's districts come in, rather than print over the island. */
    scale: 1 - regionIntro,
    // Specks keep full strength until file marks replace them: a file never
    // recedes behind the districts (ink ladder, file rung).
    specks: 1 - files,
  };
}

export function detailVisibility(
  previous: { files: boolean; composition: boolean },
  pixels: number,
  hasComposition: boolean
) {
  return {
    composition: hasComposition && pixels >= (previous.composition ? 6.2 : 7),
    files: pixels >= (previous.files ? 3.6 : 4.2),
  };
}
