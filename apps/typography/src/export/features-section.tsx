import { useCallback } from "react";
import { featureLabel } from "~/typeface/layout-features";
import { Checkbox } from "~/ui/controls/checkbox";
import { Segmented } from "~/ui/controls/segmented";
import { RuledSection } from "~/ui/layout/ruled-section";
import { type PlanDraft, toggled } from "./plan-draft";

interface FeaturesSectionProps {
  readonly draft: PlanDraft;
  readonly onChange: (change: Partial<PlanDraft>) => void;
  /** Every feature tag the chosen faces name. */
  readonly tags: readonly string[];
}

const FEATURE_OPTIONS = [
  { label: "Everything the kept glyphs need", value: "needed" },
  { label: "A chosen set", value: "chosen" },
] as const;

interface FeatureCheckProps {
  readonly onChange: (change: Partial<PlanDraft>) => void;
  readonly selected: readonly string[];
  readonly tag: string;
}

function FeatureCheck({ onChange, selected, tag }: FeatureCheckProps) {
  const toggle = useCallback(
    (on: boolean) => onChange({ featureTags: toggled(selected, tag, on) }),
    [onChange, selected, tag]
  );
  return (
    <li>
      <Checkbox
        checked={selected.includes(tag)}
        label={featureLabel(tag)}
        onChange={toggle}
      />
    </li>
  );
}

/** Which layout features the derived fonts keep. */
export function FeaturesSection({
  draft,
  onChange,
  tags,
}: FeaturesSectionProps) {
  const setFeatures = useCallback(
    (features: PlanDraft["features"]) => onChange({ features }),
    [onChange]
  );
  return (
    <RuledSection
      heading="Features"
      lede="Layout features carry ligatures, kerning and contextual forms. Keep every feature the kept glyphs need, or only a chosen set. A feature left out takes its rules with it."
    >
      <div className="ty-export-stack">
        <Segmented
          label="Features to keep"
          onChange={setFeatures}
          options={FEATURE_OPTIONS}
          value={draft.features}
        />
        {draft.features === "chosen" ? (
          <fieldset className="ty-export-options" data-wide="true">
            <legend className="ty-label">Features of the chosen faces</legend>
            {tags.length > 0 ? (
              <ul>
                {tags.map((tag) => (
                  <FeatureCheck
                    key={tag}
                    onChange={onChange}
                    selected={draft.featureTags}
                    tag={tag}
                  />
                ))}
              </ul>
            ) : (
              <p>The chosen faces have no layout features.</p>
            )}
            {draft.featureTags.length === 0 ? (
              <p className="ty-export-hint">
                With nothing chosen, the derived fonts are built without any
                layout features.
              </p>
            ) : null}
          </fieldset>
        ) : null}
      </div>
    </RuledSection>
  );
}
