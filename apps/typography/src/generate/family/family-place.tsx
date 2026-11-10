import "./family.css";
import { useCallback, useMemo } from "react";
import { exportInstancesHash } from "~/export/export-address";
import { browserImageCodec } from "~/generation/browser-image-codec";
import type {
  Availability,
  StrategyKind,
} from "~/generation/strategies/strategy";
import type { Face, VariationAxis } from "~/typeface/face";
import { codePointName } from "~/ui/content/code-point";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { RuledSection } from "~/ui/layout/ruled-section";
import { emptyReason, RequestSection } from "../request-section";
import type { Readiness } from "../run-panel";
import type { Draft } from "../session";
import { type StrategyOption, strategyOptions } from "../strategies";
import { StrategyChoice } from "../strategy-choice";
import { StylePanel } from "../style-panel";
import {
  useCandidateStatuses,
  useGenerateSession,
  useGenerateState,
  useLanguages,
  useStyleReading,
} from "../use-session";
import { FamilyBoard } from "./family-board";
import { FamilyRunPanel } from "./family-run-panel";
import type { WeightLine } from "./family-session";
import { FamilyStrategyDetails } from "./family-strategy-details";
import { useFamilyPlan, useFamilySession, useFamilyState } from "./use-family";
import { distinctWeights, startingWeights, weightName } from "./weights";
import { WeightsSection } from "./weights-section";

/** A recorded run holds one face's glyphs at one weight, so it is never coordinated. */
const NOT_ACROSS_WEIGHTS: Availability = {
  available: false,
  reason:
    "A recorded run holds the glyphs of one face at one weight, so it cannot be replayed across weights. Choose a pinned instance to replay it.",
};

const FEWEST_WEIGHTS = 2;

const BUSY_ELSEWHERE: Readiness = {
  ready: false,
  reason: "A run for another face is under way. This one can follow it.",
};

const readinessOf = (
  option: StrategyOption | undefined,
  weights: number,
  targets: number,
  leftOut: number,
  draft: Draft
): Readiness => {
  if (option && !option.availability.available) {
    return { ready: false, reason: option.availability.reason };
  }
  if (weights < FEWEST_WEIGHTS) {
    return { ready: false, reason: "Choose at least two different weights." };
  }
  if (targets > 0) {
    return { ready: true };
  }
  return {
    ready: false,
    reason:
      leftOut > 0
        ? "Every character asked for is already in the face, so there is nothing to generate."
        : emptyReason(draft),
  };
};

interface FamilyPlaceProps {
  /** The face's weight axis. */
  readonly axis: VariationAxis;
  /** A variable face. */
  readonly face: Face;
}

/**
 * The Generate place for a variable face: the same characters drawn at
 * several weights, compared character by character, and accepted into a
 * pinned instance for each weight.
 */
export function FamilyPlace({ axis, face }: FamilyPlaceProps) {
  const generate = useGenerateSession();
  const { draft, providerKey } = useGenerateState(generate);
  const family = useFamilySession();
  const {
    activity: latest,
    runs,
    shownRunId,
    weights: chosen,
  } = useFamilyState(family);
  // The run of another variable face is not this face's to show.
  const activity = latest?.faceId === face.id ? latest : undefined;
  const busy = latest?.status === "running";
  const languages = useLanguages();
  const reading = useStyleReading(generate, face);
  const { alreadyInFace, characters, plan } = useFamilyPlan(
    face,
    draft,
    languages
  );
  const entered = useMemo(
    () => chosen[face.id] ?? startingWeights(axis),
    [axis, chosen, face.id]
  );
  const weights = useMemo(
    () => distinctWeights(axis, entered),
    [axis, entered]
  );
  const options = useMemo(
    () =>
      strategyOptions(
        { codec: browserImageCodec, providerKey },
        NOT_ACROSS_WEIGHTS
      ),
    [providerKey]
  );
  const option = options.find((known) => known.kind === draft.strategy);
  const planned = useMemo(
    (): WeightLine[] =>
      weights.map((weight) => ({
        name: weightName(face, weight),
        status: "waiting",
        weight,
      })),
    [face, weights]
  );

  const setWeights = useCallback(
    (next: readonly number[]) => family.setWeights(face.id, next),
    [face.id, family]
  );
  const chooseStrategy = useCallback(
    (strategy: StrategyKind) => generate.updateDraft({ strategy }),
    [generate]
  );
  const run = useCallback(() => {
    if (draft.strategy !== "recorded-run") {
      family.run({
        characters,
        faceId: face.id,
        providerKey,
        strategy: draft.strategy,
        weights: entered,
      });
    }
  }, [characters, draft.strategy, entered, face.id, family, providerKey]);

  const mine = runs.filter((known) => known.faceId === face.id);
  const shown = mine.find((known) => known.id === shownRunId) ?? mine[0];
  const statuses = useCandidateStatuses();
  // The pinned instances that hold something a run across weights made.
  const extended = (shown?.members ?? []).filter((_, index) =>
    shown?.characters.some(({ cells }) => {
      const candidate = cells[index]?.candidate;
      return candidate && statuses.get(candidate.id) === "accepted";
    })
  );
  const targets = plan.targets.length;

  return (
    <>
      <RuledSection
        first
        heading="Generate across weights"
        lede="A variable face takes no glyphs itself, so the characters it lacks are drawn at several weights. Each weight becomes a pinned instance, and every result stays a candidate until you accept it."
      >
        <div className="ty-generate-stack">
          <RequestSection
            draft={draft}
            face={face}
            languages={languages}
            onDraft={generate.updateDraft}
            plan={plan}
            replaying={false}
          />
          {alreadyInFace.length > 0 ? (
            <Notice>
              {alreadyInFace.map(codePointName).join(", ")}{" "}
              {alreadyInFace.length === 1 ? "is" : "are"} already in the face
              and left out. A run across weights draws only characters the face
              lacks. To redraw one as a holdout test, choose a pinned instance.
            </Notice>
          ) : null}
        </div>
      </RuledSection>
      <RuledSection
        heading="Weights"
        lede="The weights to draw at: the lightest, the default and the heaviest to start with. Move each along the axis, type a value, or choose a named instance. Two at least."
      >
        <WeightsSection
          axis={axis}
          disabled={busy}
          entered={entered}
          face={face}
          onChange={setWeights}
        />
      </RuledSection>
      <RuledSection
        heading="Style reference"
        lede="What the pipeline measured from the face at its default weight. A run measures each weight again where it is pinned."
      >
        <StylePanel face={face} reading={reading} />
      </RuledSection>
      <RuledSection
        heading="Strategy"
        lede="One way of producing the glyphs, used for every weight. Each says whether it can run now, and why not when it cannot."
      >
        <div className="ty-generate-stack">
          <StrategyChoice
            disabled={busy}
            onChange={chooseStrategy}
            options={options}
            value={draft.strategy}
          />
          {option ? (
            <FamilyStrategyDetails
              onKey={generate.setProviderKey}
              option={option}
              providerKey={providerKey}
              ruled={plan.targets.filter((target) => target.recipe).length}
              targets={targets}
              weights={weights.length}
            />
          ) : null}
        </div>
      </RuledSection>
      <RuledSection
        heading="Run"
        lede="The pipeline runs once for each weight, lightest first. A weight that fails is named with its reason, and the weights before it keep what they made."
      >
        <FamilyRunPanel
          activity={activity}
          label={`Generate ${targets} ${targets === 1 ? "glyph" : "glyphs"} at ${weights.length} ${weights.length === 1 ? "weight" : "weights"}`}
          onRun={run}
          onStop={family.stop}
          planned={planned}
          readiness={
            busy && !activity
              ? BUSY_ELSEWHERE
              : readinessOf(
                  option,
                  weights.length,
                  targets,
                  alreadyInFace.length,
                  draft
                )
          }
        />
      </RuledSection>
      <RuledSection
        heading="Candidates across weights"
        lede="Each character at every weight, lightest to heaviest, with whether the weights could be masters of one variable glyph. Nothing enters a face until you accept it."
      >
        <FamilyBoard face={face} runs={mine} session={family} shown={shown} />
      </RuledSection>
      {extended.length > 0 ? (
        <RuledSection
          heading="Next"
          lede="Export builds the pinned instances as static fonts, or rebuilds them into one variable font."
        >
          <div className="ty-generate-stack">
            <div className="ty-generate-actions">
              <ButtonLink href={exportInstancesHash(face.id)}>
                Plan an export of the pinned instances
              </ButtonLink>
            </div>
            <p className="ty-generate-reason">
              Export opens with every pinned instance of{" "}
              {face.description.familyName} chosen:{" "}
              {extended.map((member) => member.styleName).join(", ")} took
              accepted glyphs from this run. Candidates still waiting stay out.
            </p>
          </div>
        </RuledSection>
      ) : null}
    </>
  );
}
