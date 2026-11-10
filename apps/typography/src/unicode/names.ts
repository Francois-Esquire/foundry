/**
 * Character names. Names Unicode derives by rule are computed; the rest load
 * on demand, a chunk of neighbouring blocks at a time.
 */
import {
  hangulSyllableName,
  isHangulSyllable,
  type NameRule,
  ruleName,
} from "./algorithmic-names";
import { NAME_CHUNK_LOADERS, NAME_CHUNK_STARTS } from "./data/name-chunks";
import { NAME_RULES } from "./data/properties";
import { decodeNames } from "./name-table";

type Names = ReadonlyMap<number, string>;

const rules: readonly NameRule[] = NAME_RULES.split(";").map((row) => {
  const [first = "0", last = "0", prefix = ""] = row.split("|");
  return {
    first: Number.parseInt(first, 36),
    last: Number.parseInt(last, 36),
    prefix,
  };
});

const chunkStarts = NAME_CHUNK_STARTS.split(",").map((start) =>
  Number.parseInt(start, 36)
);

const chunks = new Map<number, Promise<Names>>();

const loadChunk = (index: number): Promise<Names> => {
  const loading =
    chunks.get(index) ??
    (async () => {
      const chunk = await NAME_CHUNK_LOADERS[index]?.();
      return decodeNames(chunk?.NAMES ?? "");
    })();
  chunks.set(index, loading);
  return loading;
};

const ruleFor = (codePoint: number) =>
  rules.find((rule) => codePoint >= rule.first && codePoint <= rule.last);

/** Ranges whose names are a prefix followed by the code point in hex. */
export const nameRules = (): readonly NameRule[] => rules;

/**
 * The Unicode name of a character, for example DEVANAGARI LETTER KA.
 * Undefined for unassigned code points, private use, surrogates and controls,
 * which have none.
 */
export const characterName = async (
  codePoint: number
): Promise<string | undefined> => {
  if (isHangulSyllable(codePoint)) {
    return hangulSyllableName(codePoint);
  }
  const rule = ruleFor(codePoint);
  if (rule) {
    return ruleName(rule, codePoint);
  }
  const index = chunkStarts.findLastIndex((start) => start <= codePoint);
  return index === -1 ? undefined : (await loadChunk(index)).get(codePoint);
};

/** Every name Unicode lists one by one, in code point order. Loads all chunks. */
export const listedNames = async (): Promise<
  readonly (readonly [codePoint: number, name: string])[]
> => {
  const loaded = await Promise.all(
    chunkStarts.map((_, index) => loadChunk(index))
  );
  return loaded.flatMap((chunk) => [...chunk]);
};
