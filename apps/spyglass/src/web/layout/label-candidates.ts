import type { SpyglassFile, Territory } from "../data/types";
import type { InkView } from "../view/chart-view";
import type { BelongingView } from "./belonging-view";
import {
  addDomainLabel,
  addFolderLabels,
  addFrameLabels,
  addRegionLabels,
  addSelectedFileName,
  addTerritoryLabels,
  type Proposal,
  type Proposer,
} from "./label-proposals";
import {
  type LabelInputs,
  liftedY,
  type MapLabel,
  type TextMeasure,
} from "./labels";
import { insidePolygons } from "./polygons";
import { drapedHeight, flatMarkHeight, type ReliefOf } from "./terrain-height";

/**
 * The files the labels keep to, as the labels alone read the view: an
 * overlay's evidence, or, without an overlay, the active group's members,
 * so a group's file names come up with its pigment. The file marks read
 * the evidence alone, and dim nothing for a group: the fallback is the
 * labels' own, and stays out of the shared view.
 */
export function labelEvidence(
  shown: Pick<BelongingView, "activeRegion" | "evidenceFiles">
): Set<string> | undefined {
  const { activeRegion, evidenceFiles } = shown;
  if (evidenceFiles) {
    return evidenceFiles;
  }
  return activeRegion
    ? new Set(activeRegion.members.map((file) => file.id))
    : undefined;
}

const fileHeights = new WeakMap<Territory, WeakMap<SpyglassFile, number>>();

/**
 * The height a label's anchor takes: a file's name sits on the file's mark,
 * so it takes the mark's height; a name on land, the relief under it; a name
 * on the sea or a frame's label, the plane. The relief sampled is the one
 * drawn, found through `reliefOf`, since a relayout replaces the island in
 * the drawing but not its relief. File heights are kept by that relief and
 * the file, since a relayout replaces the files too.
 */
function anchorHeight(label: Proposal, reliefOf: ReliefOf): number {
  const { territory } = label;
  if (!territory) {
    return flatMarkHeight;
  }
  const relief = reliefOf(territory);
  const file = label.place?.file;
  if (!file) {
    const local = { x: label.x - territory.x, y: label.y - territory.y };
    return insidePolygons(local, territory.coast)
      ? drapedHeight(relief, label.x, label.y)
      : flatMarkHeight;
  }
  const heights =
    fileHeights.get(relief) ?? new WeakMap<SpyglassFile, number>();
  fileHeights.set(relief, heights);
  let height = heights.get(file);
  if (height === undefined) {
    height = drapedHeight(relief, territory.x + file.x, territory.y + file.y);
    heights.set(file, height);
  }
  return height;
}

/**
 * Every label the chart proposes for a frame, in priority order: the
 * selected file's name, the domain's name, the frames' labels, region names,
 * folder names, then each island's name with its file names
 * (`label-proposals.ts`). Each is measured, and boxed where it is seen over
 * the relief. `placeLabels` keeps the ones that fit.
 */
export function labelCandidates(
  inputs: LabelInputs,
  measure: TextMeasure
): MapLabel[] {
  const candidates: MapLabel[] = [];
  const proposer: Proposer = {
    add(proposal) {
      const z = anchorHeight(proposal, inputs.reliefOf);
      candidates.push({
        ...proposal,
        opacity: proposal.opacity ?? 1,
        width: measure(proposal.text, proposal.font) * proposal.height,
        y: liftedY(proposal.y, z),
        z,
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
  addDomainLabel(proposer);
  addFrameLabels(proposer);
  addRegionLabels(proposer);
  addFolderLabels(proposer, territories);
  addTerritoryLabels(proposer, territories);
  return candidates;
}

/**
 * The labels that fit, from the candidates: the selected file's name wins
 * every collision, so the island's own name, when it is the same text, is
 * left out; region names and file names are then kept within budgets that
 * grow with the view's area on screen.
 */
export function placeLabels(
  candidates: readonly MapLabel[],
  view: InkView,
  fileId: string | null
): MapLabel[] {
  const pixels = view.pixelsPerUnit;
  const area = view.width * view.height * pixels * pixels;
  const fileLabelBudget = Math.max(3, Math.floor(area / 40_000));
  const regionLabelBudget = Math.max(2, Math.min(6, Math.floor(area / 90_000)));
  let fileLabels = 0;
  let regionLabels = 0;
  const focusedName = candidates.find(
    (label) => label.place?.file?.id === fileId
  )?.text;
  const distinct = candidates.filter(
    (label) => label.kind === "file" || label.text !== focusedName
  );
  return visibleLabels(distinct, view).filter((label) => {
    if (label.kind === "region") {
      regionLabels += 1;
      if (regionLabels > regionLabelBudget) {
        return false;
      }
    }
    if (label.kind !== "file" || label.place.file.id === fileId) {
      return true;
    }
    fileLabels += 1;
    return fileLabels <= fileLabelBudget;
  });
}

/** The gap kept between placed labels and from the view's edge, in screen pixels: wider on a portrait view. */
const labelGap = { landscape: 5, portrait: 10 } as const;

/**
 * The labels that fit: candidates in priority order, each kept when it lies
 * within the view and clears every label already placed by a gap.
 */
export function visibleLabels(
  candidates: readonly MapLabel[],
  view: InkView
): MapLabel[] {
  const placed: MapLabel[] = [];
  const gap =
    (view.width < view.height ? labelGap.portrait : labelGap.landscape) /
    view.pixelsPerUnit;
  for (const label of candidates) {
    if (
      label.x - label.width / 2 < view.x - view.width / 2 + gap ||
      label.x + label.width / 2 > view.x + view.width / 2 - gap ||
      label.y - label.height < view.y - view.height / 2 + gap ||
      label.y > view.y + view.height / 2 - gap
    ) {
      continue;
    }
    if (
      placed.some(
        (p) =>
          Math.abs(p.x - label.x) < (p.width + label.width) / 2 + gap &&
          label.y + gap > p.y - p.height &&
          label.y - label.height < p.y + gap
      )
    ) {
      continue;
    }
    placed.push(label);
  }
  return placed;
}
