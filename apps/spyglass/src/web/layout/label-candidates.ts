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

export interface LabelScreen {
  at: (label: MapLabel) => { x: number; y: number };
  height: number;
  pixelsPerUnit: number;
  width: number;
}

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

const labelGap = { landscape: 5, portrait: 10 } as const;

interface ScreenBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

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
    const below =
      label.kind === "island" && label.caption !== ""
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
