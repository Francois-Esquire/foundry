import { useCallback, useMemo } from "react";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Checkbox } from "~/ui/controls/checkbox";
import { Notice } from "~/ui/controls/notice";
import { Segmented } from "~/ui/controls/segmented";
import { Slider } from "~/ui/controls/slider";
import { Columns } from "~/ui/layout/columns";
import { isolatedInk, type SeparationMethod, type Sighting } from "./core";
import { InkPicture, PixelPicture } from "./pixel-picture";
import type { ReadingOptions } from "./reading";
import {
  locked,
  type ReconstructSession,
  type ReconstructState,
} from "./session";

const METHODS: readonly {
  readonly label: string;
  readonly value: SeparationMethod;
}[] = [
  { label: "Colour", value: "colour" },
  { label: "Tone", value: "tone" },
];

const POLARITIES: readonly {
  readonly label: string;
  readonly value: ReadingOptions["lettering"];
}[] = [
  { label: "Automatic", value: "automatic" },
  { label: "Darker", value: "darker" },
  { label: "Lighter", value: "lighter" },
];

/** Below this the two classes of pixel are not really two. */
const WEAK_SEPARATION = 0.6;

function IsolationFacts({ sighting }: { readonly sighting: Sighting }) {
  const { isolation } = sighting;
  const { separation } = isolation;
  const letters = isolation.lines.reduce(
    (sum, line) => sum + line.letters.length,
    0
  );
  return (
    <TitleBlock>
      <TitleBlockItem label="Separated by">{separation.by}</TitleBlockItem>
      <TitleBlockItem label="Lettering" weight={2}>
        {separation.lettering} than the ground,{" "}
        {separation.polarity === "automatic"
          ? "read from the picture"
          : "as you set it"}
      </TitleBlockItem>
      <TitleBlockItem label="Separability">
        {separation.separability.toFixed(2)}
      </TitleBlockItem>
      <TitleBlockItem label="Stroke">
        {isolation.strokeThickness.toFixed(1)} px
      </TitleBlockItem>
      <TitleBlockItem label="Lines">{isolation.lines.length}</TitleBlockItem>
      <TitleBlockItem label="Letters">{letters}</TitleBlockItem>
      <TitleBlockItem label="Removed" weight={2}>
        {isolation.specksRemoved} specks, {isolation.rulesRemoved} ruled lines,{" "}
        {isolation.stray.length} stray pieces left aside
      </TitleBlockItem>
    </TitleBlock>
  );
}

interface IsolationSectionProps {
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** The lettering lifted off its ground, with the controls that decide how. */
export function IsolationSection({ session, state }: IsolationSectionProps) {
  const { options } = state;
  const sighting = state.reading.value?.sighting;
  const isLocked = locked(state);
  const ink = useMemo(() => sighting && isolatedInk(sighting), [sighting]);

  const setMethod = useCallback(
    (by: SeparationMethod) => session.setOptions({ by }),
    [session]
  );
  const setPolarity = useCallback(
    (lettering: ReadingOptions["lettering"]) =>
      session.setOptions({ lettering }),
    [session]
  );
  const setScale = useCallback(
    (scale: number) => session.setOptions({ scale }),
    [session]
  );
  const setRuledLines = useCallback(
    (ruledLines: boolean) => session.setOptions({ ruledLines }),
    [session]
  );

  return (
    <div className="ty-reconstruct-stack">
      <div className="ty-reconstruct-controls">
        <Segmented
          disabled={isLocked}
          label="Separate by"
          onChange={setMethod}
          options={METHODS}
          value={options.by}
        />
        <Segmented
          disabled={isLocked}
          label="Lettering is"
          onChange={setPolarity}
          options={POLARITIES}
          value={options.lettering}
        />
        <Slider
          disabled={isLocked}
          label="Enlargement, times"
          max={3}
          min={1}
          onChange={setScale}
          step={0.5}
          value={options.scale}
        />
        <Checkbox
          checked={options.ruledLines}
          disabled={isLocked}
          label="Take out ruled lines"
          onChange={setRuledLines}
        />
      </div>
      {sighting && ink ? (
        <>
          <Columns>
            <figure className="ty-reconstruct-figure">
              <PixelPicture
                image={sighting.view.image}
                label="The marked region of the photograph, upright"
              />
              <figcaption className="ty-label">The region</figcaption>
            </figure>
            <figure className="ty-reconstruct-figure">
              <InkPicture
                ink={ink}
                label="The lettering of the region, isolated from its ground"
              />
              <figcaption className="ty-label">
                The lettering, isolated
              </figcaption>
            </figure>
          </Columns>
          <IsolationFacts sighting={sighting} />
          {sighting.isolation.separation.separability < WEAK_SEPARATION ? (
            <Notice>
              The lettering and its ground are hard to tell apart here. Try the
              other separation, set whether the lettering is darker or lighter,
              or mark a tighter region.
            </Notice>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
