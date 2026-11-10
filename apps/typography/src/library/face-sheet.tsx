import "./library.css";
import { useCallback } from "react";
import type { Face } from "~/typeface/face";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button, ButtonLink } from "~/ui/controls/button";
import { RuledSection } from "~/ui/layout/ruled-section";
import { saveBytes } from "~/workspace/files";
import { useWorkspace } from "~/workspace/react";
import { CompositionPanel } from "./composition-panel";
import { formatBytes, outlineFormatLabel } from "./face-details";
import { FaceMetadata } from "./face-metadata";
import { faceLabel } from "./face-names";
import { Specimen } from "./specimen";
import { useFaceCoverage, useProject } from "./use-face";

/** Everything the library shows about one face. */
export function FaceSheet({ face }: { readonly face: Face }) {
  const workspace = useWorkspace();
  const project = useProject();
  const coverage = useFaceCoverage(face);
  const source = project.sources.find(
    (candidate) => candidate.id === face.sourceId
  );
  const { characterCount, glyphCount, outlineFormat } = face.description;

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
        lede="The face shown below. Exporting the original saves the imported file byte for byte, whatever has been edited since."
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
