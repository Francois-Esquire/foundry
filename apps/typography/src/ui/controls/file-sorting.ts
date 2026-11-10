/** Deciding which offered files a drop target takes. */

export interface FileRejection {
  readonly file: File;
  /** "type": not an accepted extension. "count": more files than allowed. */
  readonly reason: "count" | "type";
}

export interface SortedFiles {
  readonly accepted: readonly File[];
  readonly rejected: readonly FileRejection[];
}

/**
 * Matches on the file extension, because browsers leave the media type of
 * font files empty or inconsistent.
 */
const hasAcceptedType = (file: File, accept: readonly string[]) => {
  const name = file.name.toLowerCase();
  return accept.some((extension) => name.endsWith(extension.toLowerCase()));
};

export const sortFiles = (
  files: readonly File[],
  accept: readonly string[],
  multiple: boolean
): SortedFiles => {
  const accepted: File[] = [];
  const rejected: FileRejection[] = [];
  for (const file of files) {
    if (!hasAcceptedType(file, accept)) {
      rejected.push({ file, reason: "type" });
    } else if (!multiple && accepted.length > 0) {
      rejected.push({ file, reason: "count" });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
};

const sentenceList = (items: readonly string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "Takes .ttf, .otf and .woff2 files." */
export const describeAccepted = (accept: readonly string[]) =>
  `Takes ${sentenceList(accept)} files.`;

/** Names what was left out and what the target takes instead. */
export const describeRejected = (
  rejected: readonly FileRejection[],
  accept: readonly string[]
): string => {
  const wrongType = rejected
    .filter((rejection) => rejection.reason === "type")
    .map((rejection) => rejection.file.name);
  const extra = rejected
    .filter((rejection) => rejection.reason === "count")
    .map((rejection) => rejection.file.name);
  const sentences: string[] = [];
  if (wrongType.length > 0) {
    sentences.push(
      `${sentenceList(wrongType)} ${wrongType.length === 1 ? "was" : "were"} not added. Choose ${sentenceList(accept)} files.`
    );
  }
  if (extra.length > 0) {
    sentences.push(
      `Only one file can be added at a time, so ${sentenceList(extra)} ${extra.length === 1 ? "was" : "were"} left out. Add the rest one by one.`
    );
  }
  return sentences.join(" ");
};
