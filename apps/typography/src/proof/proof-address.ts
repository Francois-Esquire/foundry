/**
 * The Proof place's addresses. "#/proof/built/<id>" names a font the Export
 * place built, and "#/proof/face/<face>" a face as the project has it now.
 * Either can end in a text to set, "#/proof/face/<face>/<text>", so the place
 * that made new characters can hand them over to be proved.
 */
import type { FaceId } from "~/typeface/face";

export type SubjectRef =
  | { readonly kind: "built"; readonly id: string }
  | { readonly kind: "face"; readonly faceId: FaceId };

/** Reads "#/proof/built/<id>" and "#/proof/face/<face>". Anything else names nothing. */
export const subjectOfPath = (
  path: readonly string[]
): SubjectRef | undefined => {
  const [kind, id] = path;
  if (id === undefined) {
    return;
  }
  if (kind === "built") {
    return { id, kind: "built" };
  }
  return kind === "face" ? { faceId: id, kind: "face" } : undefined;
};

/** The text the address asks the proof to set. Undefined when it names none. */
export const textOfPath = (path: readonly string[]): string | undefined => {
  const text = path[2]?.trim();
  return text ? text : undefined;
};

export const subjectKey = (subject: SubjectRef) =>
  subject.kind === "built" ? `built:${subject.id}` : `face:${subject.faceId}`;

export const subjectOfKey = (key: string): SubjectRef | undefined => {
  const separator = key.indexOf(":");
  return subjectOfPath([key.slice(0, separator), key.slice(separator + 1)]);
};

/** The address of a subject, and of a text to set in it when one is given. */
export const subjectAddress = (subject: SubjectRef, text?: string) =>
  [
    "#/proof",
    subject.kind,
    encodeURIComponent(subject.kind === "built" ? subject.id : subject.faceId),
    ...(text?.trim() ? [encodeURIComponent(text.trim())] : []),
  ].join("/");
