import "./export.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadInBrowser } from "~/packaging/browser-check";
import { glyphRefKey, sourceGlyph } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { Language } from "~/unicode/languages";
import { scopeName } from "~/unicode/scope";
import { findScript } from "~/unicode/scripts";
import { useWorkspace } from "~/workspace/react";
import { useEngineStatus } from "~/workspace/services";
import type { Workspace } from "~/workspace/workspace";
import { arrivalOf } from "./arrival";
import { CharactersSection, type FaceSelection } from "./characters-section";
import { type ExportAddress, readExportPath } from "./export-address";
import { type FaceFacts, faceFacts } from "./face-facts";
import { FacesSection } from "./faces-section";
import { featureTagsOf } from "./feature-names";
import { FeaturesSection } from "./features-section";
import { NameSection } from "./name-section";
import { OriginalsSection } from "./originals-section";
import { type PlanDraft, resolveDraft, startDraft } from "./plan-draft";
import { PlanSection } from "./plan-section";
import { ResultsSection } from "./results-section";
import {
  keepingChosen,
  languageOptions,
  selectionOptions,
} from "./selection-options";
import { summariseSelection } from "./selection-summary";
import { type ExportSession, isOutdated } from "./session";
import { characterLookups } from "./unicode-lookups";
import {
  type LanguageData,
  useActiveFaceId,
  useExportSession,
  useLanguageData,
  useProject,
} from "./use-export";
import { VariableSection } from "./variable/variable-section";

const NO_LANGUAGES: readonly Language[] = [];

/** Every character a face has as the project stands: its source font's and the added ones. */
const charactersOf = (workspace: Workspace, faceId: FaceId): number[] => [
  ...workspace.openFace(faceId).characters(),
  ...workspace.workingFace(faceId).characters.keys(),
];

/**
 * Puts the choice an address carries into the plan, once on arriving and
 * again whenever the address changes. A bare "#/export" asks for nothing and
 * leaves the plan as it was. Returns why the address could not be followed.
 */
const useArrival = (
  address: ExportAddress | undefined,
  session: ExportSession,
  workspace: Workspace
): string | undefined => {
  const [missed, setMissed] = useState<string>();
  useEffect(() => {
    if (!address) {
      setMissed(undefined);
      return;
    }
    const { activeFaceId, project } = workspace.getState();
    const draft =
      session.getState().draft ??
      startDraft(activeFaceId ?? project.faces[0]?.id);
    const arrival = arrivalOf(address, project, draft);
    if (arrival.kind === "missed") {
      setMissed(arrival.reason);
      return;
    }
    setMissed(undefined);
    if (JSON.stringify(arrival.draft) !== JSON.stringify(draft)) {
      session.setDraft(arrival.draft);
    }
  }, [address, session, workspace]);
  return missed;
};

interface PlannerProps {
  /** What the address asks of the plan, when it asks for anything. */
  readonly address: ExportAddress | undefined;
  readonly languageData: LanguageData;
  readonly project: TypefaceProject;
}

/** The plan, from the choices that make it to the fonts built from it. */
function ExportPlanner({ address, languageData, project }: PlannerProps) {
  const workspace = useWorkspace();
  const activeFaceId = useActiveFaceId();
  const { session, state } = useExportSession();
  const missed = useArrival(address, session, workspace);
  const engineStatus = useEngineStatus();
  const languages =
    languageData.status === "loaded" ? languageData.languages : NO_LANGUAGES;

  const draft = useMemo(
    () => state.draft ?? startDraft(activeFaceId ?? project.faces[0]?.id),
    [activeFaceId, project.faces, state.draft]
  );
  const change = useCallback(
    (next: Partial<PlanDraft>) =>
      session.setDraft({ ...(session.getState().draft ?? draft), ...next }),
    [draft, session]
  );

  const facts = useMemo(() => faceFacts(project), [project]);
  const chosen = useMemo(
    () => facts.filter(({ face }) => draft.faceIds.includes(face.id)),
    [draft.faceIds, facts]
  );
  // Every table here lists faces, so a pinned instance says where it is pinned.
  const labels = useMemo(
    () => new Map(facts.map(({ face, listLabel }) => [face.id, listLabel])),
    [facts]
  );
  const sourceCharacters = useCallback(
    (faceId: FaceId) => workspace.openFace(faceId).characters(),
    [workspace]
  );

  const { resolution, typingProblems } = useMemo(
    () =>
      resolveDraft(
        project,
        draft,
        characterLookups(languages, sourceCharacters)
      ),
    [draft, languages, project, sourceCharacters]
  );

  const held = useMemo(
    () => chosen.flatMap(({ face }) => charactersOf(workspace, face.id)),
    [chosen, workspace]
  );
  const options = useMemo(() => {
    const offered = selectionOptions(held);
    return {
      blocks: keepingChosen(offered.blocks, draft.blocks, (name) => name),
      scripts: keepingChosen(
        offered.scripts,
        draft.scripts,
        (code) => findScript(code)?.name ?? code
      ),
      sharedGroups: keepingChosen(
        offered.sharedGroups,
        draft.sharedGroups,
        (group) => scopeName({ group, kind: "shared" })
      ),
    };
  }, [draft.blocks, draft.scripts, draft.sharedGroups, held]);
  const languageChoices = useMemo(
    () =>
      keepingChosen(
        languageOptions(languages, held),
        draft.languages,
        (tag) => languages.find((language) => language.tag === tag)?.name ?? tag
      ),
    [draft.languages, held, languages]
  );
  const selections = useMemo(
    () =>
      chosen.map(({ face, listLabel: label }: FaceFacts): FaceSelection => {
        const output = resolution.outputs.find(
          (candidate) => candidate.faceId === face.id
        );
        return {
          faceId: face.id,
          label,
          summary: summariseSelection({
            available: charactersOf(workspace, face.id),
            fallbackGlyph: glyphRefKey(sourceGlyph(0)),
            glyphCount:
              face.description.glyphCount +
              workspace.workingFace(face.id).added.length,
            glyphOf: (character) => {
              const glyph = workspace.glyphForCharacter(face.id, character);
              return glyph && glyphRefKey(glyph);
            },
            kept:
              output?.kind === "derived"
                ? output.request.subset?.characters
                : undefined,
          }),
        };
      }),
    [chosen, resolution, workspace]
  );
  const tags = useMemo(
    () =>
      featureTagsOf(
        chosen.map(({ face }) => face),
        (face) => workspace.workingFace(face.id).featureCode
      ),
    [chosen, workspace]
  );

  const build = useCallback(() => {
    session
      .build({ draft, project }, resolution, loadInBrowser)
      // A build never rejects: each failure is kept with its output.
      .catch(() => undefined);
  }, [draft, project, resolution, session]);

  return (
    <>
      {missed ? <Notice>{missed}</Notice> : null}
      <FacesSection draft={draft} faces={facts} onChange={change} />
      <CharactersSection
        draft={draft}
        languageData={languageData}
        languages={languageChoices}
        onChange={change}
        options={options}
        selections={selections}
      />
      <FeaturesSection draft={draft} onChange={change} tags={tags} />
      <NameSection
        draft={draft}
        faces={chosen}
        findings={[...resolution.problems, ...resolution.warnings]}
        onChange={change}
      />
      <PlanSection
        draftProblems={typingProblems}
        engineStatus={engineStatus}
        labels={labels}
        onBuild={build}
        resolution={resolution}
        run={state.run}
      />
      {state.run ? (
        <ResultsSection
          labels={labels}
          onBuildAgain={build}
          outdated={isOutdated(state.run, { draft, project })}
          project={project}
          run={state.run}
        />
      ) : null}
      <VariableSection
        familyName={draft.familyName}
        format={draft.format}
        project={project}
      />
      <OriginalsSection project={project} />
    </>
  );
}

/** Export: plan derived fonts, build and validate them, and download the results or the originals. */
export default function ExportScreen({
  path,
}: {
  /** The segments below "#/export", which can carry a choice from another place. */
  readonly path: readonly string[];
}) {
  const project = useProject();
  const languageData = useLanguageData();
  const address = useMemo(() => readExportPath(path), [path]);
  if (project.faces.length === 0) {
    return (
      <EmptyState
        action={
          <ButtonLink href="#/import" symbol="add">
            Import a font
          </ButtonLink>
        }
        symbol="export"
        title="Nothing to export yet"
      >
        Derived fonts are planned, built and validated here, and the original
        files can be downloaded unchanged. Import a font, or load the samples,
        to begin.
      </EmptyState>
    );
  }
  return (
    <div className="ty-export">
      <RuledSection
        first
        heading="Export"
        lede="Plan derived fonts from the project, see what the plan comes to, then build and validate. Downloading an original file unchanged is a separate action at the end of this page."
      >
        {languageData.status === "loading" ? (
          <ProgressLine label="Loading the language data" />
        ) : null}
      </RuledSection>
      {path.length > 0 && !address ? (
        <Notice>
          This address names nothing to plan an export from, so the plan is as
          it was. Choose the faces to export below.
        </Notice>
      ) : null}
      {/* A plan that names a language resolves wrongly before the language data is in. */}
      {languageData.status === "loading" ? null : (
        <ExportPlanner
          address={address}
          languageData={languageData}
          project={project}
        />
      )}
    </div>
  );
}
