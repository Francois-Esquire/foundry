import "./library.css";
import { RuledSection } from "~/ui/layout/ruled-section";
import { FaceSheet } from "./face-sheet";
import { FamiliesTable } from "./families-table";
import { NoFonts } from "./no-fonts";
import { useActiveFace, useProject } from "./use-face";

/** The Library: the project's fonts by family and face, and one face in full. */
export default function LibraryScreen() {
  const project = useProject();
  const face = useActiveFace();
  if (!face) {
    return (
      <NoFonts symbol="library">
        The library lists every font in the project by family and face.
      </NoFonts>
    );
  }
  return (
    <>
      <RuledSection
        first
        heading="Families"
        lede="Every face in the project, by family. Press a face to show its specimen, composition and metadata."
      >
        <div className="ty-library-families">
          <FamiliesTable activeFaceId={face.id} project={project} />
        </div>
      </RuledSection>
      <FaceSheet face={face} />
    </>
  );
}
