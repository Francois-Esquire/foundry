import { IMPORT_ADDRESS } from "~/import/import-address";
import "./export.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type LanguageData, useLanguageData } from "~/library/use-face";
import { loadInBrowser } from "~/packaging/browser-check";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { Language } from "~/unicode/languages";
import { useActiveFace, useProject, useWorkspace } from "~/workspace/react";
import { useEngineStatus } from "~/workspace/services";
import type { Workspace } from "~/workspace/workspace";
import { arrivalOf } from "./arrival";
import { CharactersSection } from "./characters-section";
import { type ExportAddress, readExportPath } from "./export-address";
import { FacesSection } from "./faces-section";
import { FeaturesSection } from "./features-section";
import { NameSection } from "./name-section";
import { OriginalsSection } from "./originals-section";
import { type PlanDraft, sameDraft } from "./plan-draft";
import { PlanSection } from "./plan-section";
import { planView } from "./plan-view";
import { ResultsSection } from "./results-section";
import { draftOf, type ExportSession, isOutdated } from "./session";
import { useExportSession } from "./use-export";
import { VariableSection } from "./variable/variable-section";

const NO_LANGUAGES: readonly Language[] = [];

/**
 * Puts the choice an address carries into the plan, once on arriving and
 * again whenever the address changes. A bare "#/export" asks for nothing and
 * leaves the plan as it was. Returns why the address could not be followed.
 */
const useArrival = (
  address: ExportAddress | undefined,
  session: ExportSession,
  workspace: Workspace,
  activeFaceId: FaceId
): string | undefined => {
  const [missed, setMissed] = useState<string>();
  useEffect(() => {
    if (!address) {
      setMissed(undefined);
      return;
    }
    const { project } = workspace.getState();
    const draft = draftOf(session.getState().draft, activeFaceId);
    const arrival = arrivalOf(address, project, draft);
    if (arrival.kind === "missed") {
      setMissed(arrival.reason);
      return;
    }
    setMissed(undefined);
    if (!sameDraft(arrival.draft, draft)) {
      session.setDraft(arrival.draft);
    }
  }, [activeFaceId, address, session, workspace]);
  return missed;
};

interface PlannerProps {
  /** The face a plan starts from until something is chosen. */
  readonly activeFaceId: FaceId;
  /** What the address asks of the plan, when it asks for anything. */
  readonly address: ExportAddress | undefined;
  readonly languageData: LanguageData;
  readonly project: TypefaceProject;
}

/** The plan, from the choices that make it to the fonts built from it. */
function ExportPlanner({
  activeFaceId,
  address,
  languageData,
  project,
}: PlannerProps) {
  const workspace = useWorkspace();
  const { session, state } = useExportSession();
  const missed = useArrival(address, session, workspace, activeFaceId);
  const engineStatus = useEngineStatus();
  const languages =
    languageData.status === "loaded" ? languageData.languages : NO_LANGUAGES;

  const draft = useMemo(
    () => draftOf(state.draft, activeFaceId),
    [activeFaceId, state.draft]
  );
  const change = useCallback(
    (next: Partial<PlanDraft>) =>
      session.setDraft({
        ...draftOf(session.getState().draft, activeFaceId),
        ...next,
      }),
    [activeFaceId, session]
  );

  const {
    facts,
    chosen,
    labels,
    resolution,
    typingProblems,
    options,
    languageChoices,
    selections,
    tags,
  } = useMemo(
    () => planView(project, draft, workspace.openFace, languages),
    [project, draft, workspace, languages]
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
  const active = useActiveFace();
  const languageData = useLanguageData();
  const address = useMemo(() => readExportPath(path), [path]);
  if (!active) {
    return (
      <EmptyState
        action={
          <ButtonLink href={IMPORT_ADDRESS} symbol="add">
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
          activeFaceId={active.id}
          address={address}
          languageData={languageData}
          project={project}
        />
      )}
    </div>
  );
}
