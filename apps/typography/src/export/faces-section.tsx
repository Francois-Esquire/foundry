import { useCallback } from "react";
import type { VariableTreatment } from "~/packaging/export-plan";
import {
  type AxisLocation,
  clampLocation,
  defaultLocation,
  type Face,
  type FaceId,
  locationKey,
} from "~/typeface/face";
import { Checkbox } from "~/ui/controls/checkbox";
import { Segmented } from "~/ui/controls/segmented";
import { Select } from "~/ui/controls/select";
import { Slider } from "~/ui/controls/slider";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { FaceFacts } from "./face-facts";
import { type PlanDraft, toggled } from "./plan-draft";

interface FacesSectionProps {
  readonly draft: PlanDraft;
  readonly faces: readonly FaceFacts[];
  readonly onChange: (change: Partial<PlanDraft>) => void;
}

const CUSTOM = "custom";

const VARIABLE_OPTIONS = [
  { label: "Keep variable", value: "keep" },
  { label: "Pin one instance", value: "pin" },
] as const;

interface TreatmentProps {
  readonly facts: FaceFacts;
  readonly onTreatment: (faceId: FaceId, treatment?: VariableTreatment) => void;
  readonly treatment: VariableTreatment | undefined;
}

/** A variable face: keep it variable, or choose the one instance to export. */
function VariableTreatmentControls({
  facts,
  onTreatment,
  treatment,
}: TreatmentProps) {
  const { face, label } = facts;
  const { axes, instances } = face.description;
  const location =
    treatment?.kind === "pinned"
      ? clampLocation(axes, treatment.location)
      : defaultLocation(axes);
  const named = instances.find(
    (instance) =>
      locationKey(clampLocation(axes, instance.location)) ===
      locationKey(location)
  );

  const pinAt = useCallback(
    (next: AxisLocation) =>
      onTreatment(face.id, { kind: "pinned", location: next }),
    [face.id, onTreatment]
  );
  const chooseKind = useCallback(
    (kind: "keep" | "pin") => {
      if (kind === "keep") {
        onTreatment(face.id, { kind: "keep-variable" });
      } else {
        pinAt(defaultLocation(axes));
      }
    },
    [axes, face.id, onTreatment, pinAt]
  );
  const chooseInstance = useCallback(
    (name: string) => {
      const instance = instances.find((candidate) => candidate.name === name);
      if (instance) {
        pinAt(clampLocation(axes, instance.location));
      }
    },
    [axes, instances, pinAt]
  );

  return (
    <div className="ty-export-treatment">
      <Segmented
        label={`How to export ${label}`}
        onChange={chooseKind}
        options={VARIABLE_OPTIONS}
        value={treatment?.kind === "pinned" ? "pin" : "keep"}
      />
      {treatment?.kind === "pinned" ? (
        <div className="ty-export-axes">
          {instances.length > 0 ? (
            <Select
              label="Named instance"
              onChange={chooseInstance}
              options={[
                ...(named
                  ? []
                  : [{ label: "A location of its own", value: CUSTOM }]),
                ...instances.map((instance) => ({
                  label: instance.name,
                  value: instance.name,
                })),
              ]}
              value={named?.name ?? CUSTOM}
            />
          ) : null}
          {axes.map((axis) => (
            <AxisSlider
              axis={axis}
              key={axis.tag}
              location={location}
              onLocation={pinAt}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface AxisSliderProps {
  readonly axis: Face["description"]["axes"][number];
  readonly location: AxisLocation;
  readonly onLocation: (location: AxisLocation) => void;
}

function AxisSlider({ axis, location, onLocation }: AxisSliderProps) {
  const move = useCallback(
    (value: number) => onLocation({ ...location, [axis.tag]: value }),
    [axis.tag, location, onLocation]
  );
  return (
    <Slider
      label={`${axis.name} (${axis.tag})`}
      max={axis.max}
      min={axis.min}
      onChange={move}
      value={location[axis.tag] ?? axis.default}
    />
  );
}

/** A pinned instance: export it where it is pinned, or as the variable font while unchanged. */
function PinnedTreatmentControls({
  facts,
  onTreatment,
  treatment,
}: TreatmentProps) {
  const { changes, face, label } = facts;
  const choose = useCallback(
    (kind: "pinned" | "variable") =>
      onTreatment(
        face.id,
        kind === "variable" ? { kind: "keep-variable" } : undefined
      ),
    [face.id, onTreatment]
  );
  return (
    <div className="ty-export-treatment">
      <Segmented
        label={`How to export ${label}`}
        onChange={choose}
        options={[
          { label: "At its pinned location", value: "pinned" },
          {
            disabled: changes > 0,
            label: "As the variable font",
            value: "variable",
          },
        ]}
        value={treatment?.kind === "keep-variable" ? "variable" : "pinned"}
      />
      {changes > 0 ? (
        <p className="ty-export-hint">
          This face has changes, and a changed face cannot stay variable.
        </p>
      ) : null}
    </div>
  );
}

interface FaceRowProps {
  readonly draft: PlanDraft;
  readonly facts: FaceFacts;
  readonly onChange: (change: Partial<PlanDraft>) => void;
}

function FaceRow({ draft, facts, onChange }: FaceRowProps) {
  const { face, label, note } = facts;
  const chosen = draft.faceIds.includes(face.id);
  const choose = useCallback(
    (on: boolean) => onChange({ faceIds: toggled(draft.faceIds, face.id, on) }),
    [draft.faceIds, face.id, onChange]
  );
  const setTreatment = useCallback(
    (faceId: FaceId, treatment?: VariableTreatment) => {
      const { [faceId]: _removed, ...others } = draft.treatments;
      onChange({
        treatments: treatment ? { ...others, [faceId]: treatment } : others,
      });
    },
    [draft.treatments, onChange]
  );
  const variable = face.description.axes.length > 0;
  const Treatment = face.pinned
    ? PinnedTreatmentControls
    : VariableTreatmentControls;
  return (
    <li>
      <div className="ty-export-face">
        <Checkbox checked={chosen} label={label} onChange={choose} />
        <span>{note}</span>
      </div>
      {chosen && variable ? (
        <Treatment
          facts={facts}
          onTreatment={setTreatment}
          treatment={draft.treatments[face.id]}
        />
      ) : null}
    </li>
  );
}

/** Which faces the plan exports, and how each variable one is treated. */
export function FacesSection({ draft, faces, onChange }: FacesSectionProps) {
  return (
    <RuledSection
      heading="Faces"
      lede="Choose the faces to export. Each becomes one file. A variable face can stay variable while it has no changes, or be pinned to one instance."
    >
      <ul className="ty-export-faces">
        {faces.map((facts) => (
          <FaceRow
            draft={draft}
            facts={facts}
            key={facts.face.id}
            onChange={onChange}
          />
        ))}
      </ul>
    </RuledSection>
  );
}
