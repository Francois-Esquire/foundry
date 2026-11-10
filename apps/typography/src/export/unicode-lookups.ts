/**
 * The Unicode data an export plan is resolved with. Packaging takes it as
 * injected lookups; this is where they are wired to `src/unicode`.
 */
import type { CharacterLookups } from "~/packaging/export-plan";
import type { FaceId } from "~/typeface/face";
import type { Language } from "~/unicode/languages";
import { charactersIn } from "~/unicode/scope";

/**
 * A language stands for the characters its everyday text needs, capitals
 * included. Characters for loanwords and names are not part of it.
 */
export const characterLookups = (
  languages: readonly Language[],
  charactersOfFace: (faceId: FaceId) => Iterable<number>
): CharacterLookups => {
  const byTag = new Map(languages.map((language) => [language.tag, language]));
  return {
    charactersOfBlock: (block) => charactersIn({ kind: "block", name: block }),
    charactersOfFace,
    charactersOfLanguage: (tag) => byTag.get(tag)?.required ?? [],
    charactersOfScript: (script) =>
      charactersIn({ code: script, kind: "script" }),
  };
};
