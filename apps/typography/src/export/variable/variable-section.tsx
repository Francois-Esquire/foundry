import { useCallback, useMemo } from "react";
import { count } from "~/lib/count";
import { loadInBrowser } from "~/packaging/browser-check";
import type { FontFlavor } from "~/packaging/building";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button } from "~/ui/controls/button";
import { Checkbox } from "~/ui/controls/checkbox";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Segmented } from "~/ui/controls/segmented";
import { RuledSection } from "~/ui/layout/ruled-section";
import { useEngineStatus } from "~/workspace/services";
import { type MasterGroup, masterGroups } from "./masters";
import { useElapsedSeconds, useVariableSession } from "./use-variable";
import {
  type MasterFacts,
  masterFactsOf,
  planVariableFont,
  type VariablePlan,
} from "./variable-plan";
import { VariableResult } from "./variable-result";
import type { VariableStep } from "./variable-run";
import {
  type ExportWay,
  isOutdated,
  type VariableBasis,
  type VariableRun,
} from "./variable-session";

const WAYS: readonly { readonly label: string; readonly value: ExportWay }[] = [
  { label: "Separate static fonts", value: "static" },
  { label: "One variable font", value: "variable" },
];

const noteOf = ({ added, overridden }: MasterFacts) =>
  [
    `${count(added, "added glyph")}`,
    overridden > 0 ? `${count(overridden, "source glyph")} changed` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ")
    .concat(".");

interface MasterRowProps {
  readonly faceId: FaceId;
  readonly included: boolean;
  readonly label: string;
  readonly note: string;
  readonly onToggle: (faceId: FaceId, included: boolean) => void;
}

function MasterRow({
  faceId,
  included,
  label,
  note,
  onToggle,
}: MasterRowProps) {
  const toggle = useCallback(
    (on: boolean) => onToggle(faceId, on),
    [faceId, onToggle]
  );
  return (
    <li>
      <div className="ty-export-face">
        <Checkbox checked={included} label={label} onChange={toggle} />
        <span>{note}</span>
      </div>
    </li>
  );
}

const STEP_WORDS: Readonly<Record<VariableStep, string>> = {
  building: "Building",
  checking: "Checking with the font engine",
  loading: "Loading in the browser",
};

interface BuildProgressProps {
  readonly fileName: string;
  readonly masters: number;
  readonly starting: boolean;
  readonly step: VariableStep;
}

/** The line that says what the engine is doing, with seconds that count so the wait is seen to move. */
function BuildProgress({
  fileName,
  masters,
  starting,
  step,
}: BuildProgressProps) {
  const elapsed = useElapsedSeconds();
  const doing =
    starting && step === "building"
      ? "Starting the font engine"
      : `${STEP_WORDS[step]}: ${fileName}`;
  return (
    <div className="ty-export-stack" data-testid="variable-progress">
      <ProgressLine label={`${doing}, ${elapsed} s`} />
      {step === "building" ? (
        <p className="ty-export-hint">
          The engine pins the source font at each of the {masters} masters and
          applies that master's changes, compares every glyph across them,
          merges them into one font, then writes the file and reads it back. It
          reports nothing until it is done. Three masters of a font of about a
          thousand glyphs took about eleven seconds when this was measured in
          Chrome.
        </p>
      ) : null}
    </div>
  );
}

interface VariableFontProps {
  readonly familyName: string;
  readonly format: FontFlavor;
  readonly group: MasterGroup;
  readonly project: TypefaceProject;
}

/** What is said beside the build button. */
const standingOf = (problems: number, waiting: boolean): string => {
  if (problems > 0) {
    return `Resolve the ${problems === 1 ? "problem" : `${problems} problems`} above to build.`;
  }
  return waiting
    ? "Another variable font is being built. This one can follow it."
    : "Nothing is built until you ask. The font stays on this machine.";
};

interface OutcomeProps {
  readonly basis: VariableBasis;
  readonly familyName: string;
  readonly onBuild: () => void;
  readonly run: VariableRun;
  readonly starting: boolean;
}

/** The build of this face's variable font: under way, refused, or built. */
function BuildOutcome({
  basis,
  familyName,
  onBuild,
  run,
  starting,
}: OutcomeProps) {
  if (run.status === "running") {
    return (
      <BuildProgress
        fileName={run.basis.fileName}
        masters={run.basis.masterIds.length}
        starting={starting}
        step={run.step}
      />
    );
  }
  return (
    <>
      {isOutdated(run, basis) ? (
        <Notice>
          The project, the masters or the name has changed since this variable
          font was built. Build again to bring it up to date.
        </Notice>
      ) : null}
      {run.status === "failed" ? (
        <Notice
          action={<Button onClick={onBuild}>Build again</Button>}
          tone="problem"
        >
          {run.basis.fileName} was not built. {run.message}
        </Notice>
      ) : (
        <VariableResult familyName={familyName} font={run.font} />
      )}
    </>
  );
}

/** The plan of one variable font, its build, and what the build produced. */
function VariableFont({
  familyName,
  format,
  group,
  project,
}: VariableFontProps) {
  const { session, state } = useVariableSession();
  const engineStatus = useEngineStatus();
  const masterIds = useMemo(
    () =>
      group.pinned
        .map((face) => face.id)
        .filter((faceId) => !state.excluded.includes(faceId)),
    [group.pinned, state.excluded]
  );
  const plan: VariablePlan = useMemo(
    () =>
      planVariableFont(project, masterIds, {
        familyName: familyName.trim() === "" ? undefined : familyName,
        flavor: format,
      }),
    [familyName, format, masterIds, project]
  );
  const facts = useMemo(
    () => masterFactsOf(project, group.pinned),
    [group.pinned, project]
  );
  const basis: VariableBasis = useMemo(
    () => ({
      fileName: plan.fileName,
      groupKey: group.key,
      masterIds,
      project,
    }),
    [group.key, masterIds, plan.fileName, project]
  );
  const build = useCallback(() => {
    if (plan.request) {
      session.build(basis, plan.request, (font, weight) =>
        loadInBrowser(font, "Variable font check", { weight })
      );
    }
  }, [basis, plan.request, session]);

  const run = state.run?.basis.groupKey === group.key ? state.run : undefined;
  const running = state.run?.status === "running";
  const [lightest] = plan.masters;
  const heaviest = plan.masters.at(-1);
  return (
    <>
      <ul
        aria-label={`Masters of ${group.familyName}`}
        className="ty-export-faces"
      >
        {facts.map((master) => (
          <MasterRow
            faceId={master.faceId}
            included={masterIds.includes(master.faceId)}
            key={master.faceId}
            label={`${master.styleName}, weight ${master.weight ?? "unknown"}`}
            note={noteOf(master)}
            onToggle={session.setMaster}
          />
        ))}
      </ul>
      <TitleBlock>
        <TitleBlockItem label="File" weight={2}>
          <span data-testid="variable-file">{plan.fileName}</span>
        </TitleBlockItem>
        <TitleBlockItem label="Masters">
          {plan.masters.length} of {group.pinned.length} pinned instances
        </TitleBlockItem>
        <TitleBlockItem label="Weight axis" weight={2}>
          {plan.masters.length > 1
            ? `${lightest?.weight} to ${heaviest?.weight}`
            : "Needs two masters"}
        </TitleBlockItem>
      </TitleBlock>
      <p>
        The family name and the format come from Format and name above. A
        rebuilt variable font keeps every character and feature of the source:
        the selection under Characters applies to static fonts only. Between two
        masters every value is interpolated in a straight line, and the source
        font's own axis mapping and the designs it had between the masters are
        not carried over.
      </p>
      <div className="ty-export-findings" data-testid="variable-problems">
        {plan.problems.map((problem) => (
          <Notice key={problem} tone="problem">
            {problem}
          </Notice>
        ))}
      </div>
      <div className="ty-export-findings" data-testid="variable-warnings">
        {plan.warnings.map((warning) => (
          <Notice key={warning}>{warning}</Notice>
        ))}
      </div>
      <div className="ty-export-actions">
        <Button
          disabled={plan.problems.length > 0 || running}
          onClick={build}
          variant="solid"
        >
          Build the variable font
        </Button>
        <p>{standingOf(plan.problems.length, running && !run)}</p>
      </div>
      {run ? (
        <BuildOutcome
          basis={basis}
          familyName={group.familyName}
          onBuild={build}
          run={run}
          starting={engineStatus === "starting"}
        />
      ) : null}
    </>
  );
}

/** One variable face's pinned instances, and the two ways to export them. */
function VariableGroup({
  familyName,
  format,
  group,
  project,
}: VariableFontProps) {
  const { session, state } = useVariableSession();
  const way = state.ways[group.key] ?? "static";
  const chooseWay = useCallback(
    (next: ExportWay) => session.setWay(group.key, next),
    [group.key, session]
  );
  if (!group.offered) {
    return (
      <Notice>
        No variable font is offered for {group.familyName}. {group.reason}
      </Notice>
    );
  }
  return (
    <div className="ty-export-stack" data-variable-group={group.familyName}>
      <Segmented
        label={`How to export the pinned instances of ${group.familyName}`}
        onChange={chooseWay}
        options={WAYS}
        value={way}
      />
      {way === "static" ? (
        <p>
          Each pinned instance is exported as its own static font. Tick the
          instances under Faces and build the plan above. Choose one variable
          font to rebuild the {count(group.pinned.length, "instance")} into a
          single file with a weight axis.
        </p>
      ) : (
        <VariableFont
          familyName={familyName}
          format={format}
          group={group}
          project={project}
        />
      )}
    </div>
  );
}

interface VariableSectionProps {
  /** As typed under Format and name. Empty keeps the source's own. */
  readonly familyName: string;
  readonly format: FontFlavor;
  readonly project: TypefaceProject;
}

/**
 * One variable font from the pinned instances of a variable face, beside
 * exporting each instance as its own static font. Shown once a variable
 * face has a pinned instance, and offered once it has two at different
 * weights.
 */
export function VariableSection({
  familyName,
  format,
  project,
}: VariableSectionProps) {
  const groups = useMemo(() => masterGroups(project), [project]);
  if (groups.length === 0) {
    return null;
  }
  return (
    <RuledSection
      heading="Variable font"
      lede="Pinned instances of one variable face, at two or more weights, can be rebuilt into one variable font with a weight axis. That is a second way to export them, beside one static font for each."
    >
      <div className="ty-export-stack">
        {groups.map((group) => (
          <VariableGroup
            familyName={familyName}
            format={format}
            group={group}
            key={group.key}
            project={project}
          />
        ))}
      </div>
    </RuledSection>
  );
}
