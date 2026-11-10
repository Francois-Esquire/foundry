import "./library.css";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import {
  type AxisLocation,
  defaultLocation,
  type Face,
  isVariable,
  type VariationAxis,
} from "~/typeface/face";
import { Slider } from "~/ui/controls/slider";
import { TextField } from "~/ui/controls/text-field";
import { ToggleButton } from "~/ui/controls/toggle-button";
import { Mark } from "~/ui/symbols/mark";
import { type AxisStop, axisStep, axisStops, moveAxis } from "./axis-controls";
import { leadingScript } from "./composition";
import type { FaceCoverage } from "./face-coverage";
import { FaceText } from "./face-text";
import {
  chooseFeature,
  type FeatureChoices,
  featureName,
  featureTags,
  isFeatureOn,
} from "./layout-features";
import { type SampleLine, sampleLines } from "./sample-lines";
import { countMissing, splitRuns } from "./text-runs";

const DEFAULT_SIZE = 72;
const SAMPLE_SIZE = 30;
const SIZE_RANGE = { max: 240, min: 12 } as const;
const FALLBACK_TEXT = "Typography";

interface AxisSliderProps {
  readonly axis: VariationAxis;
  readonly onMove: (tag: string, value: number) => void;
  readonly stops: readonly AxisStop[];
  readonly value: number;
}

function AxisSlider({ axis, onMove, stops, value }: AxisSliderProps) {
  const move = useCallback(
    (next: number) => onMove(axis.tag, next),
    [axis.tag, onMove]
  );
  return (
    <Slider
      label={axis.name}
      max={axis.max}
      min={axis.min}
      onChange={move}
      step={axisStep(axis)}
      stops={stops}
      value={value}
    />
  );
}

interface FeatureToggleProps {
  readonly on: boolean;
  readonly onChoose: (tag: string, on: boolean) => void;
  readonly tag: string;
}

function FeatureToggle({ on, onChoose, tag }: FeatureToggleProps) {
  const choose = useCallback(
    (pressed: boolean) => onChoose(tag, pressed),
    [onChoose, tag]
  );
  const name = featureName(tag);
  return (
    <ToggleButton onPressedChange={choose} pressed={on}>
      {tag}
      {name ? <span className="ty-visually-hidden">, {name}</span> : null}
    </ToggleButton>
  );
}

interface SampleRowProps {
  readonly face: Face;
  readonly features: FeatureChoices;
  readonly has: (codePoint: number) => boolean;
  readonly location: AxisLocation | undefined;
  readonly sample: SampleLine;
}

function SampleRow({ face, features, has, location, sample }: SampleRowProps) {
  const missing = useMemo(
    () => countMissing(splitRuns(sample.text, has)),
    [has, sample.text]
  );
  return (
    <li>
      <span className="ty-label">{sample.name}</span>
      <FaceText
        direction={sample.direction}
        face={face}
        features={features}
        fontSize={SAMPLE_SIZE}
        has={has}
        language={sample.language}
        location={location}
        text={sample.text}
      />
      <span className="ty-library-sample-notes">
        {sample.words ? null : (
          <span>Its characters. No sample words on file for this script.</span>
        )}
        {missing > 0 ? (
          <Mark kind="missing">
            Missing, {missing} {missing === 1 ? "character" : "characters"}
          </Mark>
        ) : null}
      </span>
    </li>
  );
}

interface SpecimenProps {
  readonly coverage: FaceCoverage;
  readonly face: Face;
}

/**
 * Text set in the face's own source font: editable text and size, a slider
 * per variation axis, a switch per layout feature, and a line for each
 * writing system the face has characters of.
 */
export function Specimen({ coverage, face }: SpecimenProps) {
  const { axes, instances, layout } = face.description;
  const variable = isVariable(face);
  const samples = useMemo(
    () => sampleLines(coverage.byScope, coverage.inSource),
    [coverage]
  );
  const [text, setText] = useState(() => {
    const leading = leadingScript(coverage.byScope);
    const sample = samples.find(
      (line) => leading?.kind === "script" && line.script === leading.code
    );
    return sample?.text ?? FALLBACK_TEXT;
  });
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [location, setLocation] = useState(() => defaultLocation(axes));
  const [features, setFeatures] = useState<FeatureChoices>({});
  const tags = useMemo(() => featureTags(layout), [layout]);

  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setText(event.currentTarget.value),
    []
  );
  const move = useCallback(
    (tag: string, value: number) =>
      setLocation((current) => moveAxis(current, tag, value)),
    []
  );
  const choose = useCallback(
    (tag: string, on: boolean) =>
      setFeatures((current) => chooseFeature(current, tag, on)),
    []
  );
  const set = variable ? location : undefined;

  return (
    <div className="ty-library-specimen">
      <div className="ty-library-specimen-controls">
        <TextField label="Specimen text" onChange={type} value={text} />
        <Slider
          label="Size, px"
          max={SIZE_RANGE.max}
          min={SIZE_RANGE.min}
          onChange={setSize}
          value={size}
        />
        {variable
          ? axes.map((axis) => (
              <AxisSlider
                axis={axis}
                key={axis.tag}
                onMove={move}
                stops={axisStops(axis, axes, instances)}
                value={location[axis.tag] ?? axis.default}
              />
            ))
          : null}
      </div>
      {tags.length > 0 ? (
        <fieldset className="ty-library-features">
          <legend className="ty-label">Layout features</legend>
          <ul>
            {tags.map((tag) => (
              <li key={tag}>
                <FeatureToggle
                  on={isFeatureOn(features, tag)}
                  onChoose={choose}
                  tag={tag}
                />
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <section
        aria-label="Text set in the face"
        className="ty-library-specimen-text"
      >
        <FaceText
          face={face}
          features={features}
          fontSize={size}
          has={coverage.inSource}
          location={set}
          text={text}
        />
      </section>
      {samples.length > 0 ? (
        <ul aria-label="Writing systems" className="ty-library-samples">
          {samples.map((sample) => (
            <SampleRow
              face={face}
              features={features}
              has={coverage.inSource}
              key={sample.script}
              location={set}
              sample={sample}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
