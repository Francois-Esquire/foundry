import { useCallback, useMemo } from "react";
import { type Face, faceListLabel } from "~/typeface/face";
import { families } from "~/typeface/project";
import { Select } from "~/ui/controls/select";
import { useProject, useWorkspace } from "~/workspace/react";

interface FaceSelectProps {
  readonly face: Face;
}

/** Chooses the face every place looks at, from all faces by family. */
export function FaceSelect({ face }: FaceSelectProps) {
  const workspace = useWorkspace();
  const project = useProject();
  const options = useMemo(
    () =>
      families(project).flatMap((family) =>
        family.faces.map((member) => ({
          label: faceListLabel(member),
          value: member.id,
        }))
      ),
    [project]
  );
  const choose = useCallback(
    (faceId: string) => {
      workspace.setActiveFace(faceId);
    },
    [workspace]
  );
  return (
    <Select label="Face" onChange={choose} options={options} value={face.id} />
  );
}
