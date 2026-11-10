/**
 * A scope is a set of characters to look at together: a script, a shared
 * group, a block, or an explicit list. The explorer, coverage and export all
 * name their characters this way, so no script needs code of its own.
 */
import { type Block, blockOf, findBlock } from "./blocks";
import {
  categoryOf,
  isAssigned,
  isCodePoint,
  propertyRuns,
  scriptOf,
} from "./characters";
import {
  charactersOfGroup,
  findScript,
  findSharedGroup,
  type SharedGroupId,
  sharedGroupOf,
} from "./scripts";

export type Scope =
  /** An ISO 15924 code, for example Deva. */
  | { readonly kind: "script"; readonly code: string }
  | { readonly kind: "shared"; readonly group: SharedGroupId }
  /** A block name, for example Basic Latin. */
  | { readonly kind: "block"; readonly name: string }
  | { readonly kind: "characters"; readonly codePoints: Iterable<number> };

const assignedIn = (block: Block) => {
  const characters: number[] = [];
  for (const run of propertyRuns(block.first, block.last)) {
    if (run.category !== "Cn") {
      for (let codePoint = run.first; codePoint <= run.last; codePoint += 1) {
        characters.push(codePoint);
      }
    }
  }
  return Uint32Array.from(characters);
};

/**
 * The characters of a scope, ascending and distinct. Scripts, shared groups
 * and blocks give their assigned characters; an unknown one gives none.
 */
export const charactersIn = (scope: Scope): Uint32Array => {
  switch (scope.kind) {
    case "script":
      return findScript(scope.code)
        ? charactersOfGroup(scope.code)
        : new Uint32Array(0);
    case "shared":
      return charactersOfGroup(scope.group);
    case "block": {
      const block = findBlock(scope.name);
      return block ? assignedIn(block) : new Uint32Array(0);
    }
    default:
      return Uint32Array.from(
        [...new Set(scope.codePoints)].filter(isCodePoint)
      ).sort();
  }
};

/** The script or shared group a character belongs to. Undefined when it has none. */
export const scopeOf = (codePoint: number): Scope | undefined => {
  if (!isAssigned(codePoint)) {
    return;
  }
  const group = sharedGroupOf(codePoint, categoryOf(codePoint));
  if (group) {
    return { group, kind: "shared" };
  }
  const code = scriptOf(codePoint);
  return findScript(code) && { code, kind: "script" };
};

/** A name for headings: Devanagari, Punctuation, Basic Latin. */
export const scopeName = (scope: Scope): string => {
  switch (scope.kind) {
    case "script":
      return findScript(scope.code)?.name ?? scope.code;
    case "shared":
      return findSharedGroup(scope.group)?.name ?? scope.group;
    case "block":
      return scope.name;
    default:
      return "Selected characters";
  }
};

/** A scope's characters that fall in one block. */
export interface BlockSection {
  /** Undefined for characters outside every block. */
  readonly block: Block | undefined;
  readonly characters: Uint32Array;
}

/** A scope's characters sectioned by block, in code point order. */
export const blockSections = (scope: Scope): BlockSection[] => {
  const characters = charactersIn(scope);
  const sections: BlockSection[] = [];
  let start = 0;
  while (start < characters.length) {
    const block = blockOf(characters[start] ?? 0);
    let end = start + 1;
    while (
      end < characters.length &&
      (block
        ? (characters[end] ?? 0) <= block.last
        : blockOf(characters[end] ?? 0) === undefined)
    ) {
      end += 1;
    }
    sections.push({ block, characters: characters.subarray(start, end) });
    start = end;
  }
  return sections;
};
