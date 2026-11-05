import {
  addFrameLabels,
  addSelectedFileName,
  addTerritoryLabels,
  islandCaption,
  type Proposer,
} from "./label-proposals";
import {
  flatMarkHeight,
  type LabelExclusion,
  type LabelInputs,
  type MapLabel,
  type TextMeasure,
} from "./labels";

/**
 * Every label the chart proposes for a frame, in priority order: the
 * selected file's name, the frames' labels, then each island's name with
 * its file names (`label-proposals.ts`). Each is measured, its anchor on
 * the paper: the map raises it onto the land as it projects it.
 * `placeLabels` keeps the ones that fit on screen.
 */
export function labelCandidates(
  inputs: LabelInputs,
  measure: TextMeasure
): MapLabel[] {
  const candidates: MapLabel[] = [];
  const proposer: Proposer = {
    add(proposal) {
      candidates.push({
        ...proposal,
        opacity: proposal.opacity ?? 1,
        width: Math.max(
          measure(proposal.text, proposal.font) * proposal.height,
          proposal.kind === "island"
            ? (measure(proposal.caption, islandCaption.font) *
                islandCaption.size) /
                inputs.view.pixelsPerUnit
            : 0
        ),
        z: flatMarkHeight,
      });
    },
    inputs,
    pixels: inputs.view.pixelsPerUnit,
  };
  const territories = [...inputs.data.territories].sort(
    (a, b) =>
      Number(b.id === inputs.selected) - Number(a.id === inputs.selected) ||
      b.files.length - a.files.length
  );
  addSelectedFileName(proposer, territories);
  addFrameLabels(proposer);
  addTerritoryLabels(proposer, territories);
  return candidates;
}

/**
 * The canvas the labels are placed on, as the camera draws it: its size in
 * CSS pixels, the CSS pixels a label's map unit spans (the scale its text
 * was sized at, so its box on screen is its width and height times this),
 * and where a label's anchor falls, by the projection that letters it. A
 * perspective camera shows the far side smaller than the near, so what
 * fits is read here, on screen, not on a rectangle of the chart.
 */
export interface LabelScreen {
  /** A label's baseline centre on screen, in CSS pixels from the canvas's top left; an unseen anchor falls well off it. */
  at: (label: MapLabel) => { x: number; y: number };
  height: number;
  pixelsPerUnit: number;
  width: number;
}

/**
 * The labels that fit, from the candidates: the selected file's name wins
 * every collision, so the island's own name, when it is the same text, is
 * left out; file names are then kept within a budget that grows with the
 * canvas's area.
 */
export function placeLabels(
  candidates: readonly MapLabel[],
  screen: LabelScreen,
  fileId: string | null,
  exclusions: readonly LabelExclusion[] = []
): MapLabel[] {
  const fileLabelBudget = Math.max(
    3,
    Math.floor((screen.width * screen.height) / 40_000)
  );
  let fileLabels = 0;
  const focusedName = candidates.find(
    (label) => label.place?.file?.id === fileId
  )?.text;
  const distinct = candidates.filter(
    (label) => label.kind === "file" || label.text !== focusedName
  );
  return visibleLabels(distinct, screen, exclusions).filter((label) => {
    if (label.kind !== "file" || label.place.file.id === fileId) {
      return true;
    }
    fileLabels += 1;
    return fileLabels <= fileLabelBudget;
  });
}

/** The gap kept between placed labels and from the canvas's edge, in screen pixels: wider on a portrait canvas. */
const labelGap = { landscape: 5, portrait: 10 } as const;

/** A label's box on screen, in CSS pixels: its text from the top of the font to the baseline. */
interface ScreenBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/**
 * The labels that fit: candidates in priority order, each kept when its
 * box on screen lies within the canvas, clears every reserved rectangle
 * (the caption and descenders below the baseline included) and clears
 * every label already placed by a gap.
 */
export function visibleLabels(
  candidates: readonly MapLabel[],
  screen: LabelScreen,
  exclusions: readonly LabelExclusion[] = []
): MapLabel[] {
  const kept: MapLabel[] = [];
  const boxes: ScreenBox[] = [];
  const gap =
    screen.width < screen.height ? labelGap.portrait : labelGap.landscape;
  const pixels = screen.pixelsPerUnit;
  for (const label of candidates) {
    const at = screen.at(label);
    const half = (label.width * pixels) / 2;
    const tall = label.height * pixels;
    const box: ScreenBox = {
      bottom: at.y,
      left: at.x - half,
      right: at.x + half,
      top: at.y - tall,
    };
    if (
      box.left < gap ||
      box.right > screen.width - gap ||
      box.top < gap ||
      box.bottom > screen.height - gap
    ) {
      continue;
    }
    // Include descenders and the island caption below the baseline when
    // reserving UI space. Layout collision priority remains unchanged.
    const below =
      label.kind === "island"
        ? islandCaption.drop + islandCaption.size
        : tall * 0.25;
    if (
      exclusions.some(
        (rect) =>
          box.right > rect.left &&
          box.left < rect.right &&
          box.bottom + below > rect.top &&
          box.top < rect.bottom
      )
    ) {
      continue;
    }
    if (
      boxes.some(
        (other) =>
          box.left < other.right + gap &&
          box.right > other.left - gap &&
          box.bottom + gap > other.top &&
          box.top < other.bottom + gap
      )
    ) {
      continue;
    }
    boxes.push(box);
    kept.push(label);
  }
  return kept;
}
