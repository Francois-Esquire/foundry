import {
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Segmented } from "~/ui/controls/segmented";
import { TextField } from "~/ui/controls/text-field";
import { Columns } from "~/ui/layout/columns";
import type { EvidenceRegion } from "./core";
import { PixelPicture } from "./pixel-picture";
import {
  asCorners,
  asRectangle,
  type RegionField,
  wholePicture,
  withRegionNumber,
} from "./region-geometry";
import { type MarkingMode, RegionPicker } from "./region-picker";
import type { ReconstructSession, ReconstructState } from "./session";
import type { Photograph } from "./use-session";

const MODES: readonly {
  readonly label: string;
  readonly value: MarkingMode;
}[] = [
  { label: "Rectangle", value: "rectangle" },
  { label: "Four corners", value: "corners" },
];

interface NumberEntry {
  readonly field: RegionField;
  readonly label: string;
  readonly value: number;
}

const CORNER_NAMES = [
  "Top left",
  "Top right",
  "Bottom right",
  "Bottom left",
] as const;

const entriesOf = (region: EvidenceRegion): NumberEntry[] => {
  if (region.kind === "rectangle") {
    return [
      {
        field: { kind: "rectangle", part: "x" },
        label: "Left",
        value: region.x,
      },
      {
        field: { kind: "rectangle", part: "y" },
        label: "Top",
        value: region.y,
      },
      {
        field: { kind: "rectangle", part: "width" },
        label: "Width",
        value: region.width,
      },
      {
        field: { kind: "rectangle", part: "height" },
        label: "Height",
        value: region.height,
      },
    ];
  }
  return region.corners.flatMap((corner, index) =>
    (["x", "y"] as const).map(
      (axis): NumberEntry => ({
        field: { axis, corner: index as 0 | 1 | 2 | 3, kind: "corner" },
        label: `${CORNER_NAMES[index]} ${axis}`,
        value: Math.round(corner[axis]),
      })
    )
  );
};

interface RegionNumberProps {
  readonly disabled: boolean;
  readonly entry: NumberEntry;
  /** Takes the number, or answers false when it does not leave a region. */
  readonly onCommit: (field: RegionField, value: number) => boolean;
}

/** One number of the region. It is taken when the field is left or Enter is pressed. */
function RegionNumber({ disabled, entry, onCommit }: RegionNumberProps) {
  const commit = useCallback(
    (field: HTMLInputElement) => {
      const typed = field.value.trim();
      const taken =
        typed !== "" &&
        (Number(typed) === entry.value || onCommit(entry.field, Number(typed)));
      if (!taken) {
        // A number that was refused gives way to the one the region has.
        field.value = String(entry.value);
      }
    },
    [entry, onCommit]
  );
  const leave = useCallback(
    (event: FocusEvent<HTMLInputElement>) => commit(event.currentTarget),
    [commit]
  );
  const pressKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        commit(event.currentTarget);
      }
    },
    [commit]
  );
  return (
    <TextField
      defaultValue={entry.value}
      disabled={disabled}
      inputMode="numeric"
      // A new value from the photograph replaces whatever was being typed.
      key={entry.value}
      label={entry.label}
      onBlur={leave}
      onKeyDown={pressKey}
      type="number"
    />
  );
}

interface RegionSectionProps {
  readonly photograph: Photograph;
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** Marking where the lettering is, and seeing that region upright. */
export function RegionSection({
  photograph,
  session,
  state,
}: RegionSectionProps) {
  const { evidence } = photograph;
  const { region } = state;
  const locked = state.proposal !== undefined || state.proposing;
  const [chosenMode, setChosenMode] = useState<MarkingMode>();
  const [problem, setProblem] = useState<string>();
  const mode: MarkingMode =
    chosenMode ?? (region?.kind === "quadrilateral" ? "corners" : "rectangle");

  const mark = useCallback(
    (marked: EvidenceRegion | undefined) => {
      if (marked) {
        setProblem(undefined);
        session.markRegion(marked);
      } else {
        setProblem(
          "Those four corners do not enclose a region. Place them again, one at each corner of the lettering."
        );
      }
    },
    [session]
  );

  const changeMode = useCallback(
    (next: MarkingMode) => {
      setChosenMode(next);
      setProblem(undefined);
      // The same place stays marked, in the other form, so its numbers can be adjusted.
      if (region && next === "corners" && region.kind === "rectangle") {
        session.markRegion(asCorners(region));
      } else if (
        region &&
        next === "rectangle" &&
        region.kind !== "rectangle"
      ) {
        session.markRegion(asRectangle(region, evidence));
      }
    },
    [evidence, region, session]
  );

  const useWhole = useCallback(() => {
    setProblem(undefined);
    const whole = wholePicture(evidence);
    session.markRegion(mode === "corners" ? asCorners(whole) : whole);
  }, [evidence, mode, session]);

  const clear = useCallback(() => {
    setProblem(undefined);
    session.markRegion(undefined);
  }, [session]);

  const commitNumber = useCallback(
    (field: RegionField, value: number): boolean => {
      const next = region && withRegionNumber(region, field, value, evidence);
      if (!next) {
        setProblem(
          "That number does not leave a region inside the photograph. Type another."
        );
        return false;
      }
      setProblem(undefined);
      session.markRegion(next);
      return true;
    },
    [evidence, region, session]
  );

  const view = state.reading?.sighting.view;
  return (
    <Columns template="minmax(0, 1fr) minmax(0, 2.2fr)">
      <div className="ty-reconstruct-stack">
        {state.proposal ? (
          <Notice>
            The region is held still while the letters proposed from it are
            decided. To change it, choose Mark or label again under Candidates.
          </Notice>
        ) : null}
        <Segmented
          disabled={locked}
          label="Mark as"
          onChange={changeMode}
          options={MODES}
          value={mode}
        />
        <p className="ty-lede">
          {mode === "rectangle"
            ? "Drag a rectangle over the lettering. Keep the edge of a sign or banner outside it: a border inside the region can be taken for a letter."
            : "Place a corner at each corner of the lettering, in any order. The region is then straightened, which undoes the slant of a flat surface seen at an angle."}
        </p>
        <div className="ty-reconstruct-actions">
          <Button disabled={locked} onClick={useWhole}>
            Use the whole photograph
          </Button>
          <Button disabled={locked || !region} onClick={clear} symbol="close">
            Clear the region
          </Button>
        </div>
        {problem ? <Notice tone="problem">{problem}</Notice> : null}
        {region ? (
          <fieldset className="ty-reconstruct-numbers" disabled={locked}>
            <legend className="ty-label">
              The region, in pixels of the photograph
            </legend>
            {entriesOf(region).map((entry) => (
              <RegionNumber
                disabled={locked}
                entry={entry}
                key={entry.label}
                onCommit={commitNumber}
              />
            ))}
          </fieldset>
        ) : (
          <p>
            Nothing is marked yet. Mark the lettering on the photograph, or use
            the whole photograph and adjust its numbers.
          </p>
        )}
        {view && region?.kind === "quadrilateral" ? (
          <figure className="ty-reconstruct-figure">
            <PixelPicture
              image={view.image}
              label="The marked region, straightened"
            />
            <figcaption className="ty-reconstruct-small">
              The region straightened: {view.image.width} by {view.image.height}{" "}
              pixels. The photograph itself is unchanged.
            </figcaption>
          </figure>
        ) : null}
      </div>
      <div>
        <RegionPicker
          disabled={locked}
          mode={mode}
          onMark={mark}
          photograph={photograph}
          region={region}
        />
      </div>
    </Columns>
  );
}
