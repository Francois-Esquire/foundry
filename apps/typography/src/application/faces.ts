/** Finding the face a command names. */
import { type Face, faceListLabel } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { Refusal } from "./refusal";

/**
 * The face with this id, or else the one face with this label. A label is
 * what `inspect` and every list of faces calls it, such as Lato Regular.
 */
export const faceNamed = (project: TypefaceProject, name: string): Face => {
  const byId = project.faces.find((face) => face.id === name);
  if (byId) {
    return byId;
  }
  const labelled = project.faces.filter((face) => faceListLabel(face) === name);
  const [only] = labelled;
  if (only && labelled.length === 1) {
    return only;
  }
  if (labelled.length > 1) {
    throw new Refusal(
      `${labelled.length} faces are called ${name}. Name the one you mean by its id: ${labelled.map((face) => face.id).join(", ")}.`
    );
  }
  const known = project.faces.map(faceListLabel);
  throw new Refusal(
    known.length > 0
      ? `This project has no face ${name}. Its faces are: ${known.join(", ")}.`
      : `This project has no face ${name}. It has no font yet: import one first.`
  );
};
