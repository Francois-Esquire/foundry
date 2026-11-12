import { useCallback, useState } from "react";
import { EXPORT_ADDRESS } from "~/export/export-address";
import { Button, ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { ProofFont } from "./proof-subject";
import { VALIDATOR_DIRECTORY, validatorCommand } from "./validator-command";

type Copying = "idle" | "copied" | "refused";

/** The first sample that is real words, which is the one worth shaping natively. */
const shapedText = (font: ProofFont) =>
  font.samples.find((entry) => !entry.generic)?.sample.text;

/** How to run the validator that shares nothing with the app, on the downloaded file. */
export function ValidatorSection({ font }: { readonly font: ProofFont }) {
  const [copying, setCopying] = useState<Copying>("idle");
  const command = validatorCommand({
    characters: font.request.subset?.characters,
    fontPath: `~/Downloads/${font.fileName}`,
    shape: shapedText(font),
  });
  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(
      () => setCopying("copied"),
      () => setCopying("refused")
    );
  }, [command]);

  if (!font.exported) {
    return (
      <RuledSection
        heading="Independent validation"
        lede="A second opinion from tools that share nothing with this app: native fontTools, the OpenType Sanitizer and native HarfBuzz."
      >
        <div className="ty-proof-stack">
          <p className="ty-lede">
            A working face built here is a proof, not an export: it is not
            renamed or checked against its licence, so there is no file to
            download and validate. Export the face to get one.
          </p>
          <div>
            <ButtonLink href={EXPORT_ADDRESS}>Open Export</ButtonLink>
          </div>
        </div>
      </RuledSection>
    );
  }
  return (
    <RuledSection
      heading="Independent validation"
      lede="A second opinion from tools that share nothing with this app: native fontTools, the OpenType Sanitizer and native HarfBuzz."
    >
      <div className="ty-proof-stack">
        <p className="ty-lede">
          Download {font.fileName} from Export, then run this from the{" "}
          <span className="ty-code">{VALIDATOR_DIRECTORY}</span> directory of
          the repository. It needs uv, which fetches the three tools the first
          time. Change the path if the file was saved somewhere else.
        </p>
        <pre
          className="ty-code ty-proof-command"
          data-testid="validator-command"
        >
          {command}
        </pre>
        <div className="ty-proof-actions">
          <Button onClick={copy}>Copy the command</Button>
          {copying === "copied" ? (
            <Notice>The command was copied.</Notice>
          ) : null}
          {copying === "refused" ? (
            <Notice tone="problem">
              The browser did not allow copying. Select the command and copy it
              by hand.
            </Notice>
          ) : null}
        </div>
        <p className="ty-lede">
          It prints one report and exits with 0 when the font is accepted: every
          table decompiles and recompiles, the sanitizer keeps every table
          {font.request.subset?.characters
            ? ", every kept character is mapped"
            : ""}
          , and the sample text is shaped by native HarfBuzz.
        </p>
      </div>
    </RuledSection>
  );
}
