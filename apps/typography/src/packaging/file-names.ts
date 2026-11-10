/** Predicts the file name of an exported font before anything is built. */
import type { FontFlavor } from "./building";

export interface FileNameParts {
  readonly familyName: string;
  readonly flavor: FontFlavor;
  /** True when the built font keeps PostScript outlines. */
  readonly postScriptOutlines: boolean;
  readonly styleName: string;
  readonly subset: boolean;
}

const NOT_IN_A_STEM = /[^\p{L}\p{N}]+/gu;

const stem = (name: string, fallback: string) =>
  name.replaceAll(NOT_IN_A_STEM, "") || fallback;

const extensionOf = ({ flavor, postScriptOutlines }: FileNameParts) => {
  if (flavor === "woff2") {
    return "woff2";
  }
  return postScriptOutlines ? "otf" : "ttf";
};

/** Family-Style.ttf, with -subset before the extension when characters or features were removed. */
export const fontFileName = (parts: FileNameParts): string => {
  const base = `${stem(parts.familyName, "Font")}-${stem(parts.styleName, "Regular")}`;
  return `${base}${parts.subset ? "-subset" : ""}.${extensionOf(parts)}`;
};

const numbered = (name: string, count: number) => {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}-${count}${name.slice(dot)}`
    : `${name}-${count}`;
};

/** Makes each name in a list unique by numbering the repeats: A.ttf, A-2.ttf. */
export const distinctFileNames = (names: readonly string[]): string[] => {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let count = 2; taken.has(candidate.toLowerCase()); count += 1) {
      candidate = numbered(name, count);
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
};
