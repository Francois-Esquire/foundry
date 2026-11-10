import "./system.css";
import { RuledSection } from "~/ui/layout/ruled-section";
import { ContentSpecimen } from "./content-specimen";
import { ControlsSpecimen } from "./controls-specimen";
import { FoundationsSpecimen } from "./foundations-specimen";
import { LayoutSpecimen } from "./layout-specimen";

/**
 * The design system on one page: every token, symbol, mark and control in
 * every state. It is the surface the screenshots are compared against.
 */
export default function SystemScreen() {
  return (
    <div className="ty-system">
      <RuledSection
        first
        heading="Design system"
        lede="Every token, symbol, mark and control of the interface, in every state. Letterforms here are stand-ins set in Sofia Sans at weight 700, and every name and number is illustrative."
      >
        {null}
      </RuledSection>
      <FoundationsSpecimen />
      <ControlsSpecimen />
      <ContentSpecimen />
      <LayoutSpecimen />
    </div>
  );
}
