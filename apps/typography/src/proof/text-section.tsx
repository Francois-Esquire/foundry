import { type ChangeEvent, useCallback, useState } from "react";
import { Notice } from "~/ui/controls/notice";
import { TextField } from "~/ui/controls/text-field";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { fontVariationSettings } from "~/workspace/browser-fonts";
import { useWorkspace } from "~/workspace/react";
import { useFontFamily } from "~/workspace/services";
import type { Proof } from "./proof";
import type { ProofFont } from "./proof-subject";
import { SetText } from "./set-text";
import type { BrowserFont } from "./use-proof";

interface TextSectionProps {
  readonly browserFont: BrowserFont;
  readonly font: ProofFont;
  readonly proof: Proof;
}

const FALLBACK_TEXT = "Letters carry the voice of a page";
const SIDE_BY_SIDE = 40;
const WATERFALL = [12, 16, 24, 36, 48, 72] as const;

const startingText = (font: ProofFont) =>
  font.samples.findLast((entry) => !entry.generic)?.sample.text ??
  font.samples[0]?.sample.text ??
  FALLBACK_TEXT;

/** The derived font's real bytes set as text, beside the source font, and at a run of sizes. */
export function TextSection({ browserFont, font, proof }: TextSectionProps) {
  const workspace = useWorkspace();
  const sourceFamily = useFontFamily(font.faceId);
  const [text, setText] = useState(() => startingText(font));
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setText(event.currentTarget.value),
    [setText]
  );
  const source = workspace.openFace(font.faceId);
  const inSource = useCallback(
    (codePoint: number) => source.glyphForCharacter(codePoint) !== undefined,
    [source]
  );
  const inDerived = useCallback(
    (codePoint: number) => proof.characters.has(codePoint),
    [proof]
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
                family={sourceFamily}
                has={inSource}
                size={SIDE_BY_SIDE}
                text={text}
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
                family={derivedFamily}
                has={inDerived}
                size={SIDE_BY_SIDE}
                text={text}
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
                    family={derivedFamily}
                    has={inDerived}
                    size={size}
                    text={text}
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
