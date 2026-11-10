import { useMemo, useSyncExternalStore } from "react";

/*
 * Location lives in the URL hash, so a reload keeps the place and no server
 * has to know the routes: "#/studio/<face>/<glyph>" is the path
 * ["studio", "<face>", "<glyph>"].
 */

const HASH_PREFIX = /^#\/?/;

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A stray percent sign is kept as typed.
    return segment;
  }
};

export const parseHash = (hash: string): readonly string[] =>
  hash
    .replace(HASH_PREFIX, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeSegment);

/** The hash for a path. Use it as an href: `<a href={hashFor("studio")}>`. */
export const hashFor = (...path: readonly string[]) =>
  `#/${path.map(encodeURIComponent).join("/")}`;

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

const currentHash = () => window.location.hash;

/** The current path, kept in step with the address bar. */
export const useHashPath = (): readonly string[] => {
  const hash = useSyncExternalStore(subscribe, currentHash);
  return useMemo(() => parseHash(hash), [hash]);
};
