/**
 * The coordinated runs of the Generate place: the same characters drawn for
 * several weights of one variable face. The family engine works on a
 * snapshot of the project, so this is where its result reaches the
 * workspace: each weight that made something is pinned, its candidates are
 * proposed, and nothing is accepted until a person asks.
 *
 * Held in memory beside the workspace, so a run outlasts a visit to another
 * place.
 */
import type { Verdict } from "~/generation/evaluation/evaluation";
import {
  type FamilyGeneration,
  type FamilyProgress,
  generateAcrossWeights,
} from "~/generation/family/coordinate";
import type { GlyphTarget } from "~/generation/plan/target";
import type { ImageCodec } from "~/generation/raster/image-codec";
import type { StrategyKind } from "~/generation/strategies/strategy";
import { count } from "~/lib/count";
import { reasonOf } from "~/lib/reason";
import { createStore } from "~/lib/store";
import { type FaceId, faceStyleName } from "~/typeface/face";
import { candidateStatuses, type NewCandidate } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import { type LiveStrategyKind, liveStrategy } from "../strategies";
import { planFamilyRequest } from "./family-plan";
import { distinctWeights, weightAxisOf, weightName } from "./weights";

export interface FamilyRunRequest {
  readonly characters: readonly number[];
  /** The variable face. */
  readonly faceId: FaceId;
  readonly strategy: LiveStrategyKind;
  readonly weights: readonly number[];
}

type MemberStatus = "failed" | "generated" | "not-run";

/** One weight of a run: the pinned instance it was made for and how it went. */
export interface FamilyMember {
  readonly faceId: FaceId;
  /** Why the weight failed. Set only for a failed weight. */
  readonly reason?: string;
  readonly status: MemberStatus;
  readonly styleName: string;
  readonly weight: number;
}

/** One character at one weight: its candidate, or why there is none. */
export interface FamilyCell {
  readonly candidate?: NewCandidate;
  readonly missing?: string;
  readonly verdict?: Verdict;
}

export interface FamilyCharacter {
  /** One cell for each member, lightest first. */
  readonly cells: readonly FamilyCell[];
  /** Whether the candidates could be masters of one variable glyph. */
  readonly compatible: boolean;
  /** Why they could not, in the family engine's own words. */
  readonly reason?: string;
  readonly target: GlyphTarget;
}

export interface FamilyRun {
  readonly characters: readonly FamilyCharacter[];
  /** The variable face the weights were pinned from. */
  readonly faceId: FaceId;
  readonly finishedAt: string;
  readonly id: string;
  /** Lightest first. */
  readonly members: readonly FamilyMember[];
  readonly strategy: {
    readonly kind: StrategyKind;
    /** The model that was called, when one was. */
    readonly model?: string;
    readonly name: string;
  };
}

export interface WeightLine {
  /** What the weight made, or why it made nothing. */
  readonly detail?: string;
  readonly name: string;
  readonly status: MemberStatus | "running" | "waiting";
  readonly weight: number;
}

/** The run under way, or the last one that ended. */
export interface FamilyActivity {
  /** The variable face the run is for. */
  readonly faceId: FaceId;
  /** Why the whole run came to nothing. A single failed weight is on its line. */
  readonly failure?: string;
  readonly lines: readonly WeightLine[];
  readonly status: "failed" | "finished" | "running";
}

export interface FamilyState {
  readonly activity?: FamilyActivity;
  /** Finished runs, the newest first. */
  readonly runs: readonly FamilyRun[];
  readonly shownRunId?: string;
  /** The weights chosen for each variable face, as entered. */
  readonly weights: Readonly<Record<FaceId, readonly number[]>>;
}

export interface FamilyMeans {
  /** Says when a run finished and when its output was produced. */
  readonly clock: () => Date;
  readonly codec: ImageCodec;
  /** Replaces the network for model calls in tests. */
  readonly modelFetch?: typeof fetch;
  readonly newId: () => string;
  /** The provider key as it stands when a run starts. Empty when there is none. */
  readonly providerKey: () => string;
  readonly workspace: Workspace;
}

export interface FamilySession {
  /** Accepts a character's proposed candidates, lightest weight first. Returns how many. */
  acceptCharacter(runId: string, key: string): number;
  /** Accepts every proposed candidate of the characters that are compatible. Returns how many. */
  acceptCompatible(runId: string): number;
  getState(): FamilyState;
  /** Rejects a character's proposed candidates at every weight. Returns how many. */
  rejectCharacter(runId: string, key: string): number;
  /** Runs the strategy at each weight and proposes what was made. Never rejects. */
  run(request: FamilyRunRequest): Promise<void>;
  setWeights(faceId: FaceId, weights: readonly number[]): void;
  showRun(runId: string): void;
  /** Stops the run under way. */
  stop(): void;
  subscribe(listener: () => void): () => void;
}

type Instance = FamilyGeneration["instances"][number];

const NOT_RUN = "Generation stopped before this weight.";
const NOT_MADE = "No candidate was made for it.";
const STOPPED =
  "The run was stopped before it finished, so nothing was proposed. Run again to start over.";

const cellOf = ({ outcome }: Instance, target: GlyphTarget): FamilyCell => {
  if (outcome.status === "failed") {
    return { missing: outcome.reason };
  }
  if (outcome.status === "not-run") {
    return { missing: NOT_RUN };
  }
  const { candidates, evaluations, record } = outcome.run;
  const candidate = candidates.find((made) => made.name === target.name);
  if (candidate) {
    return { candidate, verdict: evaluations.get(candidate.id)?.verdict };
  }
  const unmade = record.unmade.find((item) => item.key === target.key);
  return { missing: unmade?.reason ?? NOT_MADE };
};

const memberOf = ({ face, outcome, weight }: Instance): FamilyMember => ({
  faceId: face.id,
  reason: outcome.status === "failed" ? outcome.reason : undefined,
  status: outcome.status,
  styleName: faceStyleName(face),
  weight,
});

const lineOf = (instance: Instance, targets: number): WeightLine => {
  const { face, outcome, weight } = instance;
  const line = { name: faceStyleName(face), status: outcome.status, weight };
  if (outcome.status === "failed") {
    return { ...line, detail: outcome.reason };
  }
  if (outcome.status === "not-run") {
    return {
      ...line,
      detail: "Not started, because an earlier weight failed.",
    };
  }
  const made = outcome.run.candidates.length;
  return {
    ...line,
    detail:
      made === targets
        ? `${count(made, "candidate")}.`
        : `${count(made, "candidate")}. ${targets - made} of ${count(targets, "target")} not made.`,
  };
};

export const createFamilySession = (means: FamilyMeans): FamilySession => {
  const { clock, newId, workspace } = means;
  let stopper: AbortController | undefined;
  const store = createStore<FamilyState>({ runs: [], weights: {} });

  const setState = store.patch;

  /** A run that came to nothing shows its reason and no weights. */
  const fail = (faceId: FaceId, failure: string) =>
    setState({ activity: { faceId, failure, lines: [], status: "failed" } });

  /**
   * A character an instance already has an added glyph for is redrawn, so
   * accepting the candidate replaces that glyph instead of colliding with it.
   */
  const redrawing = <T extends NewCandidate>(candidate: T): T => {
    const [character] = candidate.characters;
    if (candidate.replaces || character === undefined) {
      return candidate;
    }
    const existing = workspace.glyphForCharacter(candidate.faceId, character);
    return existing?.kind === "added"
      ? { ...candidate, replaces: existing }
      : candidate;
  };

  /**
   * Pins the weights that made something and proposes their candidates, as
   * one change to the project. If the project refuses any of it, nothing is
   * pinned and nothing is proposed.
   */
  const integrate = (
    request: FamilyRunRequest,
    generation: FamilyGeneration
  ): FamilyGeneration["instances"] => {
    // A weight pinned here for the first time has no glyph of its own to redraw.
    const pinnedBefore = new Set(
      workspace.getState().project.faces.map((face) => face.id)
    );
    const instances = generation.instances.map((instance): Instance => {
      const { face, outcome } = instance;
      if (!(outcome.status === "generated" && pinnedBefore.has(face.id))) {
        return instance;
      }
      const { run } = outcome;
      return {
        ...instance,
        outcome: {
          run: { ...run, candidates: run.candidates.map(redrawing) },
          status: "generated",
        },
      };
    });
    const made = instances.filter(
      ({ outcome }) => outcome.status === "generated"
    );
    const integrated = workspace.pinAndPropose(
      request.faceId,
      made.flatMap(({ face }) => (face.pinned ? [face.pinned] : [])),
      made.flatMap(({ outcome }) =>
        outcome.status === "generated" ? outcome.run.candidates : []
      )
    );
    if (!integrated.ok) {
      throw new Error(integrated.notice.message);
    }
    return instances;
  };

  const decide = (
    cells: readonly FamilyCell[],
    decision: (candidateId: string) => { readonly ok: boolean }
  ): { readonly decided: number; readonly refused: boolean } => {
    let decided = 0;
    for (const { candidate } of cells) {
      if (
        candidate &&
        candidateStatuses(workspace.getState().project).get(candidate.id) ===
          "proposed"
      ) {
        if (!decision(candidate.id).ok) {
          return { decided, refused: true };
        }
        decided += 1;
      }
    }
    return { decided, refused: false };
  };

  const charactersOf = (runId: string) =>
    store.getState().runs.find((run) => run.id === runId)?.characters ?? [];

  const cellsOf = (runId: string, key: string) =>
    charactersOf(runId).find((character) => character.target.key === key)
      ?.cells ?? [];

  return {
    acceptCharacter: (runId, key) =>
      decide(cellsOf(runId, key), workspace.acceptCandidate).decided,
    acceptCompatible(runId) {
      let accepted = 0;
      for (const { cells, compatible } of charactersOf(runId)) {
        if (compatible) {
          const { decided, refused } = decide(cells, workspace.acceptCandidate);
          accepted += decided;
          if (refused) {
            break;
          }
        }
      }
      return accepted;
    },
    getState: store.getState,
    rejectCharacter: (runId, key) =>
      decide(cellsOf(runId, key), workspace.rejectCandidate).decided,
    async run(request) {
      if (store.getState().activity?.status === "running") {
        return;
      }
      const { faceId } = request;
      const variable = workspace
        .getState()
        .project.faces.find((face) => face.id === faceId);
      const axis = variable && weightAxisOf(variable);
      if (!(variable && axis)) {
        fail(
          request.faceId,
          "This face has no weight axis, so it cannot be generated across weights. Choose a variable face that has one."
        );
        return;
      }
      let lines: readonly WeightLine[] = distinctWeights(
        axis,
        request.weights
      ).map((weight) => ({
        name: weightName(variable, weight),
        status: "waiting",
        weight,
      }));
      const follow = ({ face, index, status }: FamilyProgress) => {
        lines = lines.map((line, at) =>
          at === index - 1
            ? {
                ...line,
                name: faceStyleName(face),
                status: status === "started" ? "running" : "generated",
              }
            : line
        );
        setState({ activity: { faceId, lines, status: "running" } });
      };
      stopper = new AbortController();
      const { signal } = stopper;
      setState({ activity: { faceId, lines, status: "running" } });
      try {
        const { plan } = planFamilyRequest(
          workspace.openFace(request.faceId),
          request.characters,
          (character) => workspace.glyphForCharacter(request.faceId, character)
        );
        if (plan.targets.length === 0) {
          throw new Error(
            "No characters the face lacks were asked for. Choose what to generate, then run again."
          );
        }
        const strategy = liveStrategy(request.strategy, {
          clock,
          codec: means.codec,
          fetch: means.modelFetch,
          providerKey: means.providerKey(),
        });
        const generation = await generateAcrossWeights({
          clock,
          codec: means.codec,
          face: plan.face,
          faceId: request.faceId,
          newId,
          onProgress: follow,
          project: workspace.getState().project,
          signal,
          strategy,
          targets: plan.targets,
          weights: request.weights,
        });
        const instances = integrate(request, generation);
        const model = instances
          .map(({ outcome }) =>
            outcome.status === "generated"
              ? outcome.run.record.model
              : undefined
          )
          .find((named) => named !== undefined);
        const run: FamilyRun = {
          characters: plan.targets.map((target, index) => ({
            cells: instances.map((instance) => cellOf(instance, target)),
            compatible: generation.compatibility[index]?.compatible ?? false,
            reason: generation.compatibility[index]?.reason,
            target,
          })),
          faceId: request.faceId,
          finishedAt: clock().toISOString(),
          id: newId(),
          members: instances.map(memberOf),
          strategy: { kind: strategy.kind, model, name: strategy.name },
        };
        setState({
          activity: {
            faceId,
            lines: instances.map((instance) =>
              lineOf(instance, plan.targets.length)
            ),
            status: "finished",
          },
          runs: [run, ...store.getState().runs],
          shownRunId: run.id,
        });
      } catch (error) {
        fail(faceId, signal.aborted ? STOPPED : reasonOf(error));
      }
    },
    setWeights: (faceId, weights) =>
      setState({ weights: { ...store.getState().weights, [faceId]: weights } }),
    showRun: (shownRunId) => setState({ shownRunId }),
    stop: () => stopper?.abort(),
    subscribe: store.subscribe,
  };
};
