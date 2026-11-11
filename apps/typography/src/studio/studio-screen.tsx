import "./studio.css";
import { useMemo } from "react";
import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { useActiveFace, useProject } from "~/workspace/react";
import { GlyphWorkbench } from "./glyph-workbench";
import { readStudioPath } from "./studio-address";

interface StudioScreenProps {
  /** For "#/studio/<face>/<glyph>" the segments below the place. */
  readonly path: readonly string[];
}

/**
 * The Studio: one glyph of one face, drawn large and edited. The address
 * names the face and the glyph; without them the Studio opens the active
 * face on its first letter.
 */
export default function StudioScreen({ path }: StudioScreenProps) {
  const project = useProject();
  const active = useActiveFace();
  const address = useMemo(() => readStudioPath(path), [path]);
  const asked = project.faces.find((known) => known.id === address.faceId);
  const face = asked ?? active;
  if (!face) {
    return (
      <EmptyState
        action={<ButtonLink href="#/import">Go to Import</ButtonLink>}
        symbol="studio"
        title="Studio"
      >
        Glyphs are drawn and edited here. Import a font first, then open one of
        its glyphs.
      </EmptyState>
    );
  }
  return (
    <>
      {address.faceId !== undefined && !asked ? (
        <Notice>
          The face in this address is not in the project. This is{" "}
          {face.description.fullName} instead.
        </Notice>
      ) : null}
      <GlyphWorkbench
        face={face}
        key={face.id}
        project={project}
        requested={address.glyph}
      />
    </>
  );
}
