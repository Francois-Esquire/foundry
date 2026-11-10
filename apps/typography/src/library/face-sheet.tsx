import "./library.css";
import { useCallback } from "react";
import { generateHash } from "~/generate/generate-address";
import { studioHash } from "~/studio/studio-address";
import { type Face, isVariable } from "~/typeface/face";
import { formatBytes } from "~/ui/content/byte-size";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button, ButtonLink } from "~/ui/controls/button";
import { RuledSection } from "~/ui/layout/ruled-section";
import { saveBytes } from "~/workspace/files";
import { useWorkspace } from "~/workspace/react";
import { CompositionPanel } from "./composition-panel";
import { outlineFormatLabel } from "./face-details";
import { FaceMetadata } from "./face-metadata";
import { faceLabel } from "./face-names";
import { Specimen } from "./specimen";
import { useFaceCoverage, useProject } from "./use-face";

const WEIGHT = "wght";

/** What Generate does for a face, named as the link that leads there. Undefined when it does nothing. */
const generateLabel = (face: Face): string | undefined => {
  if (!isVariable(face)) {
    return "Generate what it lacks";
  }
  return face.description.axes.some((axis) => axis.tag === WEIGHT)
    ? "Generate across weights"
    : undefined;
};

/** Everything the library shows about one face. */
export function FaceSheet({ face }: { readonly face: Face }) {
  const workspace = useWorkspace();
  const project = useProject();
  const coverage = useFaceCoverage(face);
  const source = project.sources.find(
    (candidate) => candidate.id === face.sourceId
  );
  const { characterCount, glyphCount, outlineFormat } = face.description;
  const generate = generateLabel(face);

  const exportOriginal = useCallback(() => {
    const outcome = workspace.exportOriginal(face.sourceId);
    if (outcome.ok) {
      saveBytes(outcome.value.fileName, outcome.value.bytes);
    }
  }, [face.sourceId, workspace]);

  return (
    <>
      <RuledSection
        heading="Face"
        lede="The face shown below. Exporting the original saves the imported file byte for byte, whatever has been edited since. A variable face is edited through a pinned instance, and is generated for at several weights at once."
      >
        <TitleBlock>
          <TitleBlockItem label="Face" weight={2}>
            {faceLabel(face)}
          </TitleBlockItem>
          <TitleBlockItem label="Glyphs">{glyphCount}</TitleBlockItem>
          <TitleBlockItem label="Characters">{characterCount}</TitleBlockItem>
          <TitleBlockItem label="Outlines" weight={2}>
            {outlineFormatLabel(outlineFormat)}
          </TitleBlockItem>
          <TitleBlockItem label="Source file" weight={2}>
            {source
              ? `${source.fileName}, ${formatBytes(source.bytes.byteLength)}`
              : "Not in the project"}
          </TitleBlockItem>
        </TitleBlock>
        <div className="ty-library-actions">
          <Button onClick={exportOriginal} symbol="download">
            Export original
          </Button>
          <ButtonLink href="#/coverage">Open coverage</ButtonLink>
          <ButtonLink href={studioHash(face.id)}>
            {isVariable(face)
              ? "Pin an instance in the Studio"
              : "Open in the Studio"}
          </ButtonLink>
          {generate ? (
            <ButtonLink href={generateHash(face.id)}>{generate}</ButtonLink>
          ) : null}
        </div>
      </RuledSection>
      <RuledSection
        heading="Specimen"
        lede="Set in the source font as imported. A character the font lacks shows as a crossed box, never in another font. Edits and added glyphs show in the Studio."
      >
        <Specimen coverage={coverage} face={face} key={face.id} />
      </RuledSection>
      <RuledSection
        heading="Composition"
        lede="The share of each writing system's characters this face has. A script leads to its characters in Coverage."
      >
        <div className="ty-library-composition">
          <CompositionPanel coverage={coverage} faceName={faceLabel(face)} />
        </div>
      </RuledSection>
      <RuledSection
        heading="Metadata"
        lede="What the font file says about itself, read from its tables and shown as written."
      >
        <FaceMetadata face={face} />
      </RuledSection>
    </>
  );
}
