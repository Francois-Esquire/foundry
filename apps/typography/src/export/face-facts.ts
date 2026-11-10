/** What the Export screen says about each face before it is chosen. */
import {
  type AxisLocation,
  type Face,
  faceStyleName,
  isVariable,
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
  /** One line on what kind of face this is: static, variable or pinned. */
  readonly note: string;
}

const counted = (count: number, singular: string) =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

/** A location in words: wght 700, wdth 87.5. */
const describeLocation = (location: AxisLocation) =>
  Object.keys(location)
    .sort()
    .map((tag) => `${tag} ${location[tag]}`)
    .join(", ");

const noteOf = (face: Face, changes: number) => {
  let kind = "Static";
  if (isVariable(face)) {
    const axes = face.description.axes.length;
    kind = `Variable, ${axes} ${axes === 1 ? "axis" : "axes"}`;
  } else if (face.pinned) {
    kind = `Pinned at ${describeLocation(face.pinned.location)}`;
  }
  return changes > 0 ? `${kind}. ${counted(changes, "change")}.` : `${kind}.`;
};

const faceLabel = (face: Face) =>
  `${face.description.familyName} ${faceStyleName(face)}`;

/** Every face of the project, grouped by family in the library's order. */
export const faceFacts = (project: TypefaceProject): FaceFacts[] =>
  families(project).flatMap((family) =>
    family.faces.map((face) => {
      const changes = appliedChanges(project, face.id).length;
      return {
        changes,
        face,
        label: faceLabel(face),
        note: noteOf(face, changes),
      };
    })
  );
