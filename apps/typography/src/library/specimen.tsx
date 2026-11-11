import "./library.css";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { count } from "~/lib/count";
import {
  type AxisLocation,
  defaultLocation,
  type Face,
  isVariable,
} from "~/typeface/face";
import {
  type FeatureChoices,
  featureName,
  featureTags,
  isFeatureOn,
  withFeature,
} from "~/typeface/layout-features";
import { Slider } from "~/ui/controls/slider";
import { TextField } from "~/ui/controls/text-field";
import { ToggleButton } from "~/ui/controls/toggle-button";
import { Mark } from "~/ui/symbols/mark";
import { countMissing, splitRuns } from "~/unicode/text-runs";
import { AxisSliders } from "./axis-controls";
import { leadingScript } from "./composition";
import type { FaceCoverage } from "./face-coverage";
import { FaceText } from "./face-text";
import { type SampleLine, sampleLines } from "./sample-lines";

const DEFAULT_SIZE = 72;
const SAMPLE_SIZE = 30;
const SIZE_RANGE = { max: 240, min: 12 } as const;
const FALLBACK_TEXT = "Typography";

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
          <Mark kind="missing">Missing, {count(missing, "character")}</Mark>
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
  const { axes, layout } = face.description;
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
  const choose = useCallback(
    (tag: string, on: boolean) =>
      setFeatures((current) => withFeature(current, tag, on)),
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
        {variable ? (
          <AxisSliders
            description={face.description}
            location={location}
            onLocation={setLocation}
          />
        ) : null}
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
