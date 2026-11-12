import { useCallback, useMemo } from "react";
import type { GlyphTarget } from "~/generation/plan/target";
import { formatCodePoint } from "~/lib/code-point";
import { count } from "~/lib/count";
import { studioHash } from "~/studio/studio-address";
import { addedGlyph } from "~/typeface/changes";
import type { Face, FaceMetrics } from "~/typeface/face";
import type { CandidateStatus } from "~/typeface/project";
import { designMark } from "~/typeface/provenance";
import { DesignFrame } from "~/ui/content/design-frame";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Select } from "~/ui/controls/select";
import { Mark } from "~/ui/symbols/mark";
import { useCandidateStatuses } from "~/workspace/react";
import { frameMark } from "../candidate-cell";
import { VERDICT_NAMES } from "../evaluation-report";
import { GlyphFigure } from "../glyph-figure";
import { formatWhen } from "../provenance-facts";
import { strategyLabel } from "../strategies";
import type {
  FamilyCell,
  FamilyCharacter,
  FamilyMember,
  FamilyRun,
  FamilySession,
} from "./family-session";

/** The last character the interface's own type is sure to draw. */
const LAST_INTERFACE_CHARACTER = 0x02_4f;
const FIRST_VISIBLE_CHARACTER = 0x21;

/** What to call a glyph in a control: its character, else its code point, else its glyph name. */
const spokenName = ({ characters, name, text }: GlyphTarget): string => {
  const [character, ...others] = characters;
  if (character === undefined) {
    return name;
  }
  return others.length === 0 &&
    character >= FIRST_VISIBLE_CHARACTER &&
    character <= LAST_INTERFACE_CHARACTER
    ? text
    : formatCodePoint(character);
};

const runLabel = ({ characters, finishedAt, members, strategy }: FamilyRun) =>
  `${formatWhen(finishedAt)}, ${strategyLabel(strategy.kind)}, ${count(characters.length, "character")} at ${count(members.length, "weight")}`;

/** Where a run's glyphs came from, said so nobody takes a rule for a model. */
const sourceOf = ({ strategy }: FamilyRun): string =>
  strategy.kind === "procedural"
    ? "Built by rule on this machine. No model was called."
    : `A live model run. ${strategy.name}.`;

type Statuses = ReadonlyMap<string, CandidateStatus>;

const proposedIn = (cells: readonly FamilyCell[], statuses: Statuses) =>
  cells.filter(
    ({ candidate }) => candidate && statuses.get(candidate.id) === "proposed"
  ).length;

interface WeightCellProps {
  readonly cell: FamilyCell;
  readonly member: FamilyMember;
  readonly metrics: FaceMetrics;
  readonly name: string;
  readonly status: CandidateStatus | undefined;
}

function Standing({ cell, status }: Pick<WeightCellProps, "cell" | "status">) {
  if (!cell.candidate) {
    return (
      <span className="ty-generate-standing">No candidate. {cell.missing}</span>
    );
  }
  if (status === "proposed") {
    return (
      <Mark kind={designMark(cell.candidate.provenance, status)}>
        Proposed, not accepted
      </Mark>
    );
  }
  if (status === "accepted") {
    return <Mark kind="revisions">Accepted, a revision on this instance</Mark>;
  }
  return (
    <span className="ty-generate-standing">
      {status === "rejected"
        ? "Rejected. It stays out of the face."
        : "No longer in the project."}
    </span>
  );
}

/** One character at one weight: the candidate in its frame, the weight, its standing. */
function WeightCell({ cell, member, metrics, name, status }: WeightCellProps) {
  const standing = cell.candidate ? (status ?? "gone") : "none";
  return (
    <li
      className="ty-family-cell"
      data-status={standing}
      data-weight={member.weight}
    >
      <DesignFrame
        className="ty-generate-frame"
        mark={
          cell.candidate ? frameMark(cell.candidate.provenance, status) : "none"
        }
      >
        {cell.candidate ? (
          <GlyphFigure
            advance={cell.candidate.advance}
            metrics={metrics}
            name={`Candidate for ${name} at ${member.styleName}, weight ${member.weight}, in carbon`}
            outline={cell.candidate.outline}
          />
        ) : (
          <span className="ty-family-empty">Nothing drawn</span>
        )}
      </DesignFrame>
      <span className="ty-label ty-generate-literal">
        {member.styleName}, {member.weight}
      </span>
      <Standing cell={cell} status={status} />
      {cell.verdict ? (
        <span className="ty-generate-standing">
          Evaluation: {VERDICT_NAMES[cell.verdict].toLowerCase()}.
        </span>
      ) : null}
      {cell.candidate && status === "accepted" ? (
        <ButtonLink
          href={studioHash(
            member.faceId,
            cell.candidate.replaces ?? addedGlyph(cell.candidate.id)
          )}
        >
          Open in the Studio
          <span className="ty-visually-hidden">
            , {name} at {member.styleName}
          </span>
        </ButtonLink>
      ) : null}
    </li>
  );
}

interface CharacterRowProps {
  readonly character: FamilyCharacter;
  readonly members: readonly FamilyMember[];
  readonly metrics: FaceMetrics;
  readonly onAccept: (key: string) => void;
  readonly onReject: (key: string) => void;
  readonly statuses: Statuses;
}

/** One character across the weights, lightest first, with whether they could be one variable glyph. */
function CharacterRow({
  character,
  members,
  metrics,
  onAccept,
  onReject,
  statuses,
}: CharacterRowProps) {
  const { cells, compatible, reason, target } = character;
  const name = spokenName(target);
  const shown = <span className="ty-generate-literal">{name}</span>;
  const proposed = proposedIn(cells, statuses);
  const accept = useCallback(
    () => onAccept(target.key),
    [onAccept, target.key]
  );
  const reject = useCallback(
    () => onReject(target.key),
    [onReject, target.key]
  );
  const everywhere = proposed === members.length;
  return (
    <li
      className="ty-family-character"
      data-character={target.key}
      data-compatible={compatible}
    >
      <h3 className="ty-label">
        {name === target.text ? <>{shown}, </> : null}
        {target.name}
        {target.characters.length > 0
          ? `, ${target.characters.map(formatCodePoint).join(" ")}`
          : ""}
      </h3>
      <p className="ty-family-compatibility" data-compatible={compatible}>
        <span className="ty-label ty-generate-tag">
          {compatible ? "Compatible" : "Not compatible"}
        </span>
        <span>
          {compatible
            ? "Every weight draws it with the same contours and points, so the candidates can be masters of one variable glyph."
            : `These cannot be masters of one variable glyph. ${reason ?? ""}`}
        </span>
      </p>
      <ol
        aria-label={`Candidates for ${name}, lightest to heaviest`}
        className="ty-family-figures"
      >
        {cells.map((cell, index) => {
          const member = members[index];
          return member ? (
            <WeightCell
              cell={cell}
              key={member.faceId}
              member={member}
              metrics={metrics}
              name={name}
              status={cell.candidate && statuses.get(cell.candidate.id)}
            />
          ) : null;
        })}
      </ol>
      {proposed > 0 ? (
        <div className="ty-generate-actions">
          <Button onClick={accept} symbol="check" variant="solid">
            <span>
              Accept {shown}{" "}
              {everywhere
                ? "at every weight"
                : `at the ${count(proposed, "weight")} still proposed`}
            </span>
          </Button>
          <Button onClick={reject} symbol="close">
            <span>
              Reject {shown}{" "}
              {everywhere
                ? "at every weight"
                : `at the ${count(proposed, "weight")} still proposed`}
            </span>
          </Button>
          {compatible ? null : (
            <span className="ty-generate-reason">
              Accepting it is enough for static fonts. A variable font built
              from these weights would refuse this glyph.
            </span>
          )}
        </div>
      ) : null}
    </li>
  );
}

interface FamilyBoardProps {
  readonly face: Face;
  readonly runs: readonly FamilyRun[];
  readonly session: FamilySession;
  /** The run on the board. Undefined before the first run. */
  readonly shown: FamilyRun | undefined;
}

/**
 * The candidates of one coordinated run, character by character, each drawn
 * at every weight from lightest to heaviest. A character is accepted or
 * rejected at all its weights in one action, and nothing is accepted before
 * a person asks.
 */
export function FamilyBoard({ face, runs, session, shown }: FamilyBoardProps) {
  const statuses = useCandidateStatuses();
  const options = useMemo(
    () => runs.map((run) => ({ label: runLabel(run), value: run.id })),
    [runs]
  );
  const shownId = shown?.id;
  const accept = useCallback(
    (key: string) => {
      if (shownId !== undefined) {
        session.acceptCharacter(shownId, key);
      }
    },
    [session, shownId]
  );
  const reject = useCallback(
    (key: string) => {
      if (shownId !== undefined) {
        session.rejectCharacter(shownId, key);
      }
    },
    [session, shownId]
  );
  const acceptCompatible = useCallback(() => {
    if (shownId !== undefined) {
      session.acceptCompatible(shownId);
    }
  }, [session, shownId]);

  if (!shown) {
    return (
      <p className="ty-lede">
        No run yet. Run a generation above and each character appears here at
        every weight, in a dotted frame until you accept or reject it.
      </p>
    );
  }
  const { characters, members } = shown;
  const compatible = characters.filter((character) => character.compatible);
  const waiting = compatible.filter(
    (character) => proposedIn(character.cells, statuses) > 0
  ).length;
  const tally = { accepted: 0, proposed: 0, rejected: 0 };
  for (const { candidate } of characters.flatMap(({ cells }) => cells)) {
    const status = candidate && statuses.get(candidate.id);
    if (status) {
      tally[status] += 1;
    }
  }
  return (
    <div className="ty-generate-stack">
      {runs.length > 1 ? (
        <div className="ty-generate-fields">
          <Select
            label="Run on the board"
            onChange={session.showRun}
            options={options}
            value={shown.id}
          />
        </div>
      ) : null}
      <p
        data-run-source={shown.strategy.kind === "procedural" ? "rule" : "live"}
      >
        {count(characters.length, "character")} at{" "}
        {count(members.length, "weight")} of {face.description.familyName} from
        the {strategyLabel(shown.strategy.kind).toLowerCase()} strategy.{" "}
        {sourceOf(shown)} {compatible.length} of {characters.length} could be
        masters of one variable glyph. {tally.proposed} proposed,{" "}
        {tally.accepted} accepted, {tally.rejected} rejected.
      </p>
      {compatible.length < characters.length ? (
        <Notice>
          {count(characters.length - compatible.length, "character")} cannot
          interpolate between these weights. Each says why below. A variable
          font can be built only from characters every weight draws the same
          way.
        </Notice>
      ) : null}
      <div className="ty-generate-actions">
        <Button
          disabled={waiting === 0}
          onClick={acceptCompatible}
          symbol="check"
        >
          Accept everything that is compatible ({count(waiting, "character")})
        </Button>
        <span className="ty-generate-reason">
          Every acceptance is its own revision on the pinned instance of its
          weight, so each can be undone.
        </span>
      </div>
      <ul
        aria-label="Characters across weights"
        className="ty-family-characters"
      >
        {characters.map((character) => (
          <CharacterRow
            character={character}
            key={character.target.key}
            members={members}
            metrics={face.description.metrics}
            onAccept={accept}
            onReject={reject}
            statuses={statuses}
          />
        ))}
      </ul>
    </div>
  );
}
