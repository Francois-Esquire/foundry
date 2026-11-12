import { RECONSTRUCT_ADDRESS } from "~/reconstruct/reconstruct-address";
import { ButtonLink } from "~/ui/controls/button";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";

/**
 * What the first place says while the project is empty: what the app does,
 * in two sentences, and the two ways in. The way in with a font is the rest
 * of this screen; the way in with an image is Reconstruct.
 */
export function StartSection() {
  return (
    <RuledSection
      first
      heading="Start"
      lede="Typography is a studio for looking closely at a typeface, editing its glyphs and adding the characters it lacks, ending in a font you can export. A photograph of lettering can be rebuilt into a face that goes through the same Studio and the same export."
    >
      <Columns>
        <div className="ty-import-column">
          <h3 className="ty-label">Bring a font</h3>
          <p>
            Add font files below, or load a sample font. The Library and
            Coverage then show what the font holds and what it lacks.
          </p>
        </div>
        <div className="ty-import-column">
          <h3 className="ty-label">Bring an image</h3>
          <p>
            Open a photograph of lettering in Reconstruct, or one of its sample
            photographs. Its letters are read against the fonts in the project,
            so with no font here yet you label each letter yourself.
          </p>
          <div className="ty-import-actions">
            <ButtonLink href={RECONSTRUCT_ADDRESS}>Open Reconstruct</ButtonLink>
          </div>
        </div>
      </Columns>
    </RuledSection>
  );
}
