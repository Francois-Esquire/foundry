/**
 * Coordinated generation: the same glyphs made for several weights of one
 * variable face. Each weight is pinned as an instance, one strategy runs for
 * the same targets on every instance, and the result says, glyph by glyph,
 * whether the candidates could be masters of one variable glyph.
 */

import { reasonOf } from "~/lib/reason";
import {
  type AxisLocation,
  clampLocation,
  type Face,
  type FaceId,
  faceName,
  faceStyleName,
  type VariationAxis,
} from "~/typeface/face";
import {
  findFace,
  pinInstance,
  type TypefaceProject,
} from "~/typeface/project";
import type { HeightModel } from "../normalise/height-model";
import {
  type GenerationRequest,
  type GenerationRun,
  runGeneration,
} from "../pipeline/run";
import type { GlyphTarget } from "../plan/target";
import { StrategyUnavailableError } from "../strategies/strategy";
import { analyseStyle, type StyleReference } from "../style/reference";
import { type Compatibility, compatibilityOf } from "./compatibility";
import { distinctWeights, FEWEST_WEIGHTS } from "./weights";

const WEIGHT = "wght";

type InstanceOutcome =
  | { readonly status: "generated"; readonly run: GenerationRun }
  /** The strategy or a stage threw. Instances before it keep what they made. */
  | { readonly status: "failed"; readonly reason: string }
  /** An earlier instance failed, so this one was never started. */
  | { readonly status: "not-run" };

interface InstanceGeneration {
  /** The pinned instance the candidates are for. */
  readonly face: Face;
  readonly outcome: InstanceOutcome;
  readonly weight: number;
}

interface TargetCompatibility extends Compatibility {
  readonly key: string;
  /** The glyph's name, the same in every instance. */
  readonly name: string;
}

export interface FamilyProgress {
  readonly face: Face;
  /** Position among the instances, from 1. */
  readonly index: number;
  readonly of: number;
  readonly status: "started" | "finished";
}

export interface FamilyRequest
  extends Pick<
    GenerationRequest,
    | "clock"
    | "codec"
    | "composer"
    | "newId"
    | "signal"
    | "strategy"
    | "vectorizer"
  > {
  /** The variable face, open. Every instance is read from it at its own weight. */
  readonly face: GenerationRequest["face"];
  readonly faceId: FaceId;
  /** The height model for a style. The Latin model when absent. */
  readonly heightModel?: (style: StyleReference) => HeightModel;
  readonly onProgress?: (progress: FamilyProgress) => void;
  readonly project: TypefaceProject;
  /** The same targets for every instance, planned once from the variable face. */
  readonly targets: readonly GlyphTarget[];
  /** Values on the weight axis. Each is pinned, lightest first. */
  readonly weights: readonly number[];
}

export interface FamilyGeneration {
  /** One entry per target, in the order of the targets. */
  readonly compatibility: readonly TargetCompatibility[];
  /** Lightest first. */
  readonly instances: readonly InstanceGeneration[];
  /**
   * The project with every instance pinned. The candidates are not in it:
   * propose the ones worth keeping.
   */
  readonly project: TypefaceProject;
}

export class FamilyGenerationError extends Error {
  override readonly name = "FamilyGenerationError";
}

/** The style name of a weight: the face's named instance there, or the axis value. */
const styleNameAt = (variable: Face, location: AxisLocation): string => {
  const named = variable.description.instances.find((instance) =>
    variable.description.axes.every(
      (axis) =>
        (instance.location[axis.tag] ?? axis.default) === location[axis.tag]
    )
  );
  return named?.name ?? `${WEIGHT}${location[WEIGHT]}`;
};

const weightAxisOf = (variable: Face): VariationAxis => {
  const name = faceName(variable);
  if (variable.pinned) {
    throw new FamilyGenerationError(
      `${name} is a pinned instance. Coordinated weights start from the variable face it was pinned from.`
    );
  }
  const axis = variable.description.axes.find(
    (candidate) => candidate.tag === WEIGHT
  );
  if (!axis) {
    throw new FamilyGenerationError(
      `${name} has no weight axis. Coordinated weights need a variable face that has one.`
    );
  }
  return axis;
};

interface Pinned {
  readonly instances: readonly {
    readonly face: Face;
    readonly weight: number;
  }[];
  readonly project: TypefaceProject;
}

/** Pins an instance per weight, lightest first. Weights outside the axis move to its ends. */
const pinWeights = (request: FamilyRequest): Pinned => {
  const variable = findFace(request.project, request.faceId);
  const axis = weightAxisOf(variable);
  const weights = distinctWeights(axis, request.weights);
  if (weights.length < FEWEST_WEIGHTS) {
    throw new FamilyGenerationError(
      "Coordinated generation needs at least two different weights."
    );
  }
  return weights.reduce<Pinned>(
    (pinned, weight) => {
      const location = clampLocation(variable.description.axes, {
        [WEIGHT]: weight,
      });
      const { face, project } = pinInstance(
        pinned.project,
        variable.id,
        location,
        styleNameAt(variable, location)
      );
      return { instances: [...pinned.instances, { face, weight }], project };
    },
    { instances: [], project: request.project }
  );
};

const generateFor = (
  request: FamilyRequest,
  instance: Face
): Promise<GenerationRun> => {
  const location = instance.pinned?.location;
  const style = analyseStyle(request.face, { location });
  return runGeneration({
    clock: request.clock,
    codec: request.codec,
    composer: request.composer,
    face: request.face,
    faceId: instance.id,
    heightModel: request.heightModel?.(style),
    location,
    newId: request.newId,
    signal: request.signal,
    strategy: request.strategy,
    style,
    targets: request.targets,
    vectorizer: request.vectorizer,
  });
};

const NOT_RUN = "Generation stopped before this instance.";
const NOT_MADE = "No candidate was made for it.";

/** One instance's drawing of a target, or why it has none. */
const drawingOf = (
  { face, outcome }: InstanceGeneration,
  target: GlyphTarget
) => {
  const label = faceStyleName(face);
  if (outcome.status === "failed") {
    return { label, missing: outcome.reason };
  }
  if (outcome.status === "not-run") {
    return { label, missing: NOT_RUN };
  }
  const candidate = outcome.run.candidates.find(
    (made) => made.name === target.name
  );
  if (candidate) {
    return { label, outline: candidate.outline };
  }
  const unmade = outcome.run.record.unmade.find(
    (item) => item.key === target.key
  );
  return { label, missing: unmade?.reason ?? NOT_MADE };
};

/** Compares, target by target, what each instance made. */
const compatibilityAcross = (
  targets: readonly GlyphTarget[],
  instances: readonly InstanceGeneration[]
): TargetCompatibility[] =>
  targets.map((target) => ({
    ...compatibilityOf(
      instances.map((instance) => drawingOf(instance, target))
    ),
    key: target.key,
    name: target.name,
  }));

/**
 * Pins an instance per weight and runs the strategy on each, one at a time.
 * A strategy that is unavailable throws before anything is pinned. If one
 * instance fails, the instances before it keep what they made and the ones
 * after it are not started, so nothing more is spent.
 */
export const generateAcrossWeights = async (
  request: FamilyRequest
): Promise<FamilyGeneration> => {
  const availability = request.strategy.availability();
  if (!availability.available) {
    throw new StrategyUnavailableError(availability.reason);
  }
  const pinned = pinWeights(request);
  const instances: InstanceGeneration[] = [];
  let stopped = false;
  for (const [index, { face, weight }] of pinned.instances.entries()) {
    request.signal?.throwIfAborted();
    if (stopped) {
      instances.push({ face, outcome: { status: "not-run" }, weight });
      continue;
    }
    const progress = { face, index: index + 1, of: pinned.instances.length };
    request.onProgress?.({ ...progress, status: "started" });
    try {
      // One at a time: a model strategy is paid per call, and a failure has to stop the rest.
      const run = await generateFor(request, face);
      instances.push({ face, outcome: { run, status: "generated" }, weight });
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }
      stopped = true;
      instances.push({
        face,
        outcome: { reason: reasonOf(error), status: "failed" },
        weight,
      });
    }
    request.onProgress?.({ ...progress, status: "finished" });
  }
  return {
    compatibility: compatibilityAcross(request.targets, instances),
    instances,
    project: pinned.project,
  };
};
