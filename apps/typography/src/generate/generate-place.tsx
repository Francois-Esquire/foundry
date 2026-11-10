import { useCallback, useEffect, useMemo } from "react";
import { browserImageCodec } from "~/generation/browser-image-codec";
import type {
  Availability,
  StrategyKind,
} from "~/generation/strategies/strategy";
import type { Face } from "~/typeface/face";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { Language } from "~/unicode/languages";
import { useWorkspace } from "~/workspace/react";
import { CandidateBoard } from "./candidate-board";
import {
  missingForLanguage,
  missingInScope,
  scopeFromKey,
} from "./missing-characters";
import { planRequest, type RequestPlan } from "./request-plan";
import { emptyReason, RequestSection } from "./request-section";
import { type Readiness, RunPanel } from "./run-panel";
import { RunRecordPanel } from "./run-record";
import type { CatalogueState, Draft, RunRequest } from "./session";
import { type StrategyOption, strategyOptions } from "./strategies";
import { StrategyChoice } from "./strategy-choice";
import { StrategyDetails } from "./strategy-details";
import { StylePanel } from "./style-panel";
import { readTypedCharacters } from "./typed-characters";
import {
  useClassification,
  useGenerateSession,
  useGenerateState,
  useLanguages,
  useStyleReading,
} from "./use-session";

const recordedAvailability = (
  catalogue: CatalogueState,
  chosen: boolean
): Availability => {
  if (catalogue.status === "failed") {
    return {
      available: false,
      reason: "The recorded runs could not be listed.",
    };
  }
  if (catalogue.status !== "listed") {
    return { available: false, reason: "The recorded runs are being listed." };
  }
  return chosen
    ? { available: true }
    : { available: false, reason: "No recorded run is served with this app." };
};

/** The characters a draft asks for, and their plan for one face. */
const useRequestPlan = (
  face: Face,
  draft: Draft,
  languages: readonly Language[] | undefined
): { readonly characters: readonly number[]; readonly plan: RequestPlan } => {
  const workspace = useWorkspace();
  const { classify } = useClassification(face);
  const characters = useMemo(() => {
    if (draft.source === "typed") {
      return readTypedCharacters(draft.typed);
    }
    if (draft.source === "script") {
      const scope = scopeFromKey(draft.scope);
      return scope ? missingInScope(scope, classify) : [];
    }
    const language = languages?.find((known) => known.tag === draft.language);
    return language ? missingForLanguage(language, classify) : [];
  }, [classify, draft, languages]);
  const plan = useMemo(
    () =>
      planRequest(workspace.openFace(face.id), characters, (character) =>
        workspace.glyphForCharacter(face.id, character)
      ),
    [characters, face.id, workspace]
  );
  return { characters, plan };
};

const requestOf = (
  face: Face,
  draft: Draft,
  characters: readonly number[],
  plan: RequestPlan
): RunRequest | undefined => {
  if (draft.strategy === "recorded-run") {
    return { entryId: draft.recordedId, faceId: face.id, kind: "recorded" };
  }
  return plan.targets.length > 0
    ? {
        characters,
        faceId: face.id,
        kind: "characters",
        strategy: draft.strategy,
      }
    : undefined;
};

const readinessOf = (
  option: StrategyOption | undefined,
  request: RunRequest | undefined,
  draft: Draft
): Readiness => {
  if (option && !option.availability.available) {
    return { ready: false, reason: option.availability.reason };
  }
  return request
    ? { ready: true }
    : { ready: false, reason: emptyReason(draft) };
};

interface GeneratePlaceProps {
  readonly face: Face;
}

/** The Generate place for one editable face: request, style, strategy, run, candidates, record. */
export function GeneratePlace({ face }: GeneratePlaceProps) {
  const session = useGenerateSession();
  const state = useGenerateState(session);
  const languages = useLanguages();
  const reading = useStyleReading(session, face);
  const { activity, catalogue, draft, providerKey, runs } = state;
  const { characters, plan } = useRequestPlan(face, draft, languages);

  useEffect(() => {
    session.listRecorded();
  }, [session]);

  const recorded = useMemo(
    () =>
      catalogue.status === "listed"
        ? catalogue.catalogue.entries.find(
            (entry) => entry.id === draft.recordedId
          )
        : undefined,
    [catalogue, draft.recordedId]
  );
  const options = useMemo(
    () =>
      strategyOptions(
        { codec: browserImageCodec, providerKey },
        recordedAvailability(catalogue, recorded !== undefined)
      ),
    [catalogue, providerKey, recorded]
  );
  const option = options.find((known) => known.kind === draft.strategy);
  const replaying = draft.strategy === "recorded-run";
  const request = useMemo(
    () => requestOf(face, draft, characters, plan),
    [characters, draft, face, plan]
  );

  const run = useCallback(() => {
    if (request) {
      session.run(request);
    }
  }, [request, session]);
  const chooseStrategy = useCallback(
    (strategy: StrategyKind) => session.updateDraft({ strategy }),
    [session]
  );
  const chooseRecorded = useCallback(
    (recordedId: string) => session.updateDraft({ recordedId }),
    [session]
  );

  const shown = runs.find((known) => known.id === state.shownRunId) ?? runs[0];
  const busy = activity?.status === "running";
  const count = replaying ? 0 : plan.targets.length;

  return (
    <>
      <RuledSection
        first
        heading="Generate"
        lede="Choose an editable face and the characters to draw for it. Every result arrives as a candidate and stays out of the face until you accept it."
      >
        <RequestSection
          draft={draft}
          face={face}
          languages={languages}
          onDraft={session.updateDraft}
          plan={plan}
          replaying={replaying}
        />
      </RuledSection>
      <RuledSection
        heading="Style reference"
        lede="What the pipeline measured from the face, and the sheet a model would be shown."
      >
        <StylePanel face={face} reading={reading} />
      </RuledSection>
      <RuledSection
        heading="Strategy"
        lede="One way of producing the glyphs. Each says whether it can run now, and why not when it cannot."
      >
        <div className="ty-generate-stack">
          <StrategyChoice
            disabled={busy}
            onChange={chooseStrategy}
            options={options}
            value={draft.strategy}
          />
          {option ? (
            <StrategyDetails
              catalogue={catalogue}
              face={face}
              onChooseRecorded={chooseRecorded}
              onKey={session.setProviderKey}
              onListRecorded={session.listRecorded}
              option={option}
              providerKey={providerKey}
              recorded={recorded}
              ruled={plan.targets.filter((target) => target.recipe).length}
              targets={plan.targets.length}
            />
          ) : null}
        </div>
      </RuledSection>
      <RuledSection
        heading="Run"
        lede="Analyse and plan, then the pipeline: generate, extract, normalise, compose, validate, refine, integrate. A failure names its stage and the reason."
      >
        <RunPanel
          activity={activity}
          label={
            replaying
              ? "Replay the recorded run"
              : `Generate ${count} ${count === 1 ? "glyph" : "glyphs"}`
          }
          onRun={run}
          onStop={session.stop}
          readiness={readinessOf(option, request, draft)}
        />
      </RuledSection>
      <RuledSection
        heading="Candidates"
        lede="Each candidate with where it came from and how it measured against the face. Nothing enters the face until you accept it."
      >
        <CandidateBoard
          busy={busy}
          runs={runs}
          session={session}
          shown={shown}
        />
      </RuledSection>
      {shown ? (
        <RuledSection
          heading="Run record"
          lede="What made the candidates on the board, when, what it cost, and how long each stage took."
        >
          <RunRecordPanel run={shown} />
        </RuledSection>
      ) : null}
    </>
  );
}
