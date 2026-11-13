import { useCallback, useEffect, useMemo } from "react";
import { useProviderKey } from "~/application/react";
import type { StrategyKind } from "~/generation/strategies/strategy";
import { useLanguageData } from "~/library/use-face";
import type { Face } from "~/typeface/face";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { Language } from "~/unicode/languages";
import { useCandidateStatuses, useWorkspace } from "~/workspace/react";
import { CandidateBoard } from "./candidate-board";
import { NextLinks } from "./next-links";
import {
  namedCharacters,
  readinessOf,
  recordedAvailability,
  requestOf,
} from "./request-draft";
import {
  type Asked,
  charactersToAsk,
  planRequest,
  type RequestPlan,
} from "./request-plan";
import { RequestSection } from "./request-section";
import { RunPanel } from "./run-panel";
import { RunRecordPanel } from "./run-record";
import type { Draft } from "./session";
import { StrategyChoice } from "./strategy-choice";
import { StrategyDetails } from "./strategy-details";
import { StylePanel } from "./style-panel";
import {
  useClassification,
  useGenerateSession,
  useGenerateState,
  useStyleReading,
} from "./use-session";

/**
 * The characters a draft asks its strategy for, and their plan for one face.
 * The run is asked for the same characters the plan shows.
 */
const useRequestPlan = (
  face: Face,
  draft: Draft,
  languages: readonly Language[] | undefined
): { readonly asked: Asked; readonly plan: RequestPlan } => {
  const workspace = useWorkspace();
  const { classify } = useClassification(face);
  const named = useMemo(
    () => namedCharacters(draft, classify, languages),
    [classify, draft, languages]
  );
  const asked = useMemo(
    () =>
      charactersToAsk(workspace.openFace(face.id), named, {
        source: draft.source,
        strategy: draft.strategy,
      }),
    [draft.source, draft.strategy, face.id, named, workspace]
  );
  const plan = useMemo(
    () =>
      planRequest(workspace.openFace(face.id), asked.characters, (character) =>
        workspace.glyphForCharacter(face.id, character)
      ),
    [asked, face.id, workspace]
  );
  return { asked, plan };
};

interface GeneratePlaceProps {
  readonly face: Face;
}

/** The Generate place for one editable face: request, style, strategy, run, candidates, record. */
export function GeneratePlace({ face }: GeneratePlaceProps) {
  const session = useGenerateSession();
  const state = useGenerateState(session);
  const languageData = useLanguageData();
  const languages =
    languageData.status === "loaded" ? languageData.languages : undefined;
  const reading = useStyleReading(session, face);
  const { activity, catalogue, draft, runs } = state;
  const [providerKey, setProviderKey] = useProviderKey();
  const { asked, plan } = useRequestPlan(face, draft, languages);
  const { characters } = asked;

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
  // Asked again each time this draws: the session reads the key as it stands.
  const options = session.strategyOptions(
    recordedAvailability(catalogue, recorded !== undefined)
  );
  const option = options.find((known) => known.kind === draft.strategy);
  const replaying = draft.strategy === "recorded-run";
  const request = useMemo(
    () => requestOf(face, draft, characters, plan, recorded),
    [characters, draft, face, plan, recorded]
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
  const statuses = useCandidateStatuses();
  const accepted = useMemo(
    () =>
      (shown?.faceId === face.id ? shown.candidates : [])
        .filter(({ candidate }) => statuses.get(candidate.id) === "accepted")
        .flatMap(({ candidate }) => candidate.characters),
    [face.id, shown, statuses]
  );
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
          noRule={asked.noRule}
          onDraft={session.updateDraft}
          plan={plan}
          replaying={replaying}
        />
      </RuledSection>
      <RuledSection
        heading="Style reference"
        lede="What the pipeline measured from the source font as imported, and the sheet a model would be shown. Edits and accepted glyphs are not counted."
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
              onKey={setProviderKey}
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
          readiness={readinessOf(option, request, draft, asked.noRule)}
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
      {accepted.length > 0 ? (
        <RuledSection
          heading="Next"
          lede="Proof sets the face in text. Export builds a derived font."
        >
          <NextLinks accepted={accepted} face={face} />
        </RuledSection>
      ) : null}
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
