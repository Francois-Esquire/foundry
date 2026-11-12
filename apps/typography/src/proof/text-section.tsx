import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { SetText } from "~/ui/content/set-text";
import { Notice } from "~/ui/controls/notice";
import { TextField } from "~/ui/controls/text-field";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { SAMPLE_TEXT } from "~/unicode/sample-text";
import { splitRuns } from "~/unicode/text-runs";
import { fontVariationSettings } from "~/workspace/browser-fonts";
import { useWorkspace } from "~/workspace/react";
import { useFontFamily } from "~/workspace/services";
import type { Proof } from "./proof";
import type { ProofFont } from "./proof-subject";
import type { BrowserFont } from "./use-proof";

interface TextSectionProps {
  /** A text another place handed over to be set, when the address names one. */
  readonly asked?: string;
  readonly browserFont: BrowserFont;
  readonly font: ProofFont;
  readonly proof: Proof;
}

const FALLBACK_TEXT = SAMPLE_TEXT.Latn.text;
const SIDE_BY_SIDE = 40;
const WATERFALL = [12, 16, 24, 36, 48, 72] as const;

const startingText = (font: ProofFont) =>
  font.samples.findLast((entry) => !entry.generic)?.sample.text ??
  font.samples[0]?.sample.text ??
  FALLBACK_TEXT;

/** The derived font's real bytes set as text, beside the source font, and at a run of sizes. */
export function TextSection({
  asked,
  browserFont,
  font,
  proof,
}: TextSectionProps) {
  const workspace = useWorkspace();
  const sourceFamily = useFontFamily(font.faceId);
  const [text, setText] = useState(() => asked ?? startingText(font));
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setText(event.currentTarget.value),
    [setText]
  );
  const source = workspace.openFace(font.faceId);
  const sourceRuns = useMemo(
    () =>
      splitRuns(
        text,
        (codePoint) => source.glyphForCharacter(codePoint) !== undefined
      ),
    [source, text]
  );
  const derivedRuns = useMemo(
    () => splitRuns(text, (codePoint) => proof.characters.has(codePoint)),
    [proof, text]
  );
  const { location } = font.request;

  if (browserFont.status === "refused") {
    return (
      <RuledSection heading="In text">
        <Notice tone="problem">
          The browser does not load this font, so no text can be set in it:{" "}
          {browserFont.message} Build it again, and if it is refused again the
          build is at fault.
        </Notice>
      </RuledSection>
    );
  }
  const derivedFamily =
    browserFont.status === "loaded" ? browserFont.family : undefined;
  return (
    <RuledSection
      heading="In text"
      lede="The same text in the source font and in the derived font's real bytes, as the browser sets them. A character a font lacks is drawn as a crossed box."
    >
      <div className="ty-proof-stack">
        <TextField
          autoComplete="off"
          label="Proof text"
          onChange={type}
          spellCheck={false}
          value={text}
        />
        <Columns>
          <figure className="ty-proof-specimen">
            <figcaption className="ty-label">Source font</figcaption>
            {sourceFamily ? (
              <SetText
                className="ty-proof-text"
                family={sourceFamily}
                runs={sourceRuns}
                size={SIDE_BY_SIDE}
                variation={location && fontVariationSettings(location)}
              />
            ) : (
              <p>
                The browser cannot set text in this member of a font collection.
                The pixel comparison below draws it from its outlines.
              </p>
            )}
          </figure>
          <figure className="ty-proof-specimen">
            <figcaption className="ty-label">Derived font</figcaption>
            {derivedFamily ? (
              <SetText
                className="ty-proof-text"
                family={derivedFamily}
                runs={derivedRuns}
                size={SIDE_BY_SIDE}
              />
            ) : (
              <p>The browser is loading the font.</p>
            )}
          </figure>
        </Columns>
        {derivedFamily ? (
          <div>
            <h3 className="ty-label">Waterfall, derived font</h3>
            <ul className="ty-proof-waterfall">
              {WATERFALL.map((size) => (
                <li key={size}>
                  <span className="ty-code">{size} px</span>
                  <SetText
                    className="ty-proof-text"
                    family={derivedFamily}
                    runs={derivedRuns}
                    size={size}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </RuledSection>
  );
}
