import { useEffect, useState } from "react";
import { searchCharacters } from "~/unicode/search";

const RESULT_LIMIT = 600;

export interface CharacterSearch {
  /** True while the newest query is still being answered. */
  readonly pending: boolean;
  /**
   * Undefined when nothing is being searched for. While the newest query is
   * pending these are the results of the one before it, so the grid does not
   * empty between keystrokes.
   */
  readonly results: readonly number[] | undefined;
}

interface Answer {
  readonly query: string;
  readonly results: readonly number[];
}

/**
 * Searches characters as the query changes. Name search loads its data on
 * first use, so answers arrive later and only the newest query's is kept.
 */
export const useCharacterSearch = (query: string): CharacterSearch => {
  const wanted = query.trim();
  const [answer, setAnswer] = useState<Answer>();
  useEffect(() => {
    if (wanted === "") {
      return;
    }
    let current = true;
    searchCharacters(wanted, { limit: RESULT_LIMIT }).then((results) => {
      if (current) {
        setAnswer({ query: wanted, results });
      }
    });
    return () => {
      current = false;
    };
  }, [wanted]);
  if (wanted === "") {
    return { pending: false, results: undefined };
  }
  return {
    pending: answer?.query !== wanted,
    results: answer?.results ?? [],
  };
};
