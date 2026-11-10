/** What the Export screen says about each face before it is chosen. */
import {
  type Face,
  faceListLabel,
  faceStyleName,
  isVariable,
  locationLabel,
} from "~/typeface/face";
import {
  appliedChanges,
  families,
  type TypefaceProject,
} from "~/typeface/project";

export interface FaceFacts {
  /** Changes currently applied to the face. */
  readonly changes: number;
  readonly face: Face;
  /** Family and style, for example Lato Regular. */
  readonly label: string;
  /** The label for a list of faces, where a pinned instance says where it is pinned. */
  readonly listLabel: string;
  /** One line on what kind of face this is: static, variable or pinned. */
  readonly note: string;
  /** True when the face's source font is one the app made for a reconstruction. */
  readonly reconstructed: boolean;
}

const counted = (count: number, singular: string) =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const noteOf = (face: Face, changes: number) => {
  let kind = "Static";
  if (isVariable(face)) {
    const axes = face.description.axes.length;
    kind = `Variable, ${axes} ${axes === 1 ? "axis" : "axes"}`;
  } else if (face.pinned) {
    kind = `Pinned at ${locationLabel(face.pinned.location)}`;
  }
  return changes > 0 ? `${kind}. ${counted(changes, "change")}.` : `${kind}.`;
};

const faceLabel = (face: Face) =>
  `${face.description.familyName} ${faceStyleName(face)}`;

/** Every face of the project, grouped by family in the library's order. */
export const faceFacts = (project: TypefaceProject): FaceFacts[] => {
  const madeByApp = new Set(
    project.sources
      .filter((source) => source.madeFor === "reconstruction")
      .map((source) => source.id)
  );
  return families(project).flatMap((family) =>
    family.faces.map((face) => {
      const changes = appliedChanges(project, face.id).length;
      return {
        changes,
        face,
        label: faceLabel(face),
        listLabel: faceListLabel(face),
        note: noteOf(face, changes),
        reconstructed: madeByApp.has(face.sourceId),
      };
    })
  );
};
