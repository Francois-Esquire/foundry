import { GlyphCell } from "~/ui/content/glyph-cell";
import { Button } from "~/ui/controls/button";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { ScrollRegion } from "~/ui/layout/scroll-region";
import { SplitView } from "~/ui/layout/split-view";
import { Tape } from "~/ui/layout/tape";
import { LineSymbol } from "~/ui/symbols/line-symbol";
import { Mark } from "~/ui/symbols/mark";
import { type Theme, useTheme } from "~/ui/theme";

const REVISIONS = Array.from({ length: 12 }, (_, index) => 12 - index);
const RESIZE = { max: 420, min: 200 } as const;

const TAPE_NAMES: Readonly<Record<Theme, string>> = {
  black: "Black tape",
  white: "White tape",
};

export function LayoutSpecimen() {
  const theme = useTheme();
  const reverse: Theme = theme === "black" ? "white" : "black";
  return (
    <>
      <RuledSection
        heading="Layout"
        lede="A ruled section, like this one, opens with an ink rule. Columns are separated by hairlines. A split view puts an inspector beside the work."
      >
        <Columns>
          <p>
            Columns share the width equally unless a template says otherwise.
          </p>
          <p>Hairline rules separate them, and none are drawn outside.</p>
          <p>Below 560 pixels the columns stack and the rules go.</p>
        </Columns>
        <div className="ty-system-block ty-system-split">
          <SplitView
            fill
            inspector={
              <ScrollRegion label="Revisions">
                <ol className="ty-system-list">
                  {REVISIONS.map((revision) => (
                    <li key={revision}>
                      <span>{revision}</span>
                      <span>Spacing adjusted</span>
                    </li>
                  ))}
                </ol>
              </ScrollRegion>
            }
            inspectorLabel="Inspector"
            inspectorWidth={280}
            resize={RESIZE}
          >
            <p className="ty-lede">
              The work area takes the remaining width. Drag the handle on the
              rule, or focus it and press the arrow keys, to resize the
              inspector. The list inside it is a scroll region.
            </p>
          </SplitView>
        </div>
      </RuledSection>

      <RuledSection
        heading={TAPE_NAMES[reverse]}
        lede="The other theme. The same marks in reverse, with carbon blue adjusted to keep its contrast."
      >
        <Tape theme={reverse}>
          <div className="ty-system-tape">
            <LineSymbol name="studio" />
            <Mark kind="source" />
            <Mark kind="edited" />
            <Mark kind="unconfirmed" />
            <Mark kind="missing" />
            <Button>Compare</Button>
            <Button variant="solid">Accept</Button>
            <Button disabled>Export</Button>
            <div className="ty-system-tape-cells">
              <GlyphCell codePoint={0x41} state="source">
                A
              </GlyphCell>
              <GlyphCell codePoint={0x42} state="edited">
                B
              </GlyphCell>
              <GlyphCell codePoint={0x43} selected state="candidate">
                C
              </GlyphCell>
              <GlyphCell codePoint={0x44} state="missing" />
            </div>
          </div>
        </Tape>
      </RuledSection>
    </>
  );
}
