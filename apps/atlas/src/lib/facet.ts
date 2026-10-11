import { z } from "zod";

// Facet syntax: how the configuration addresses a place, a workspace-relative
// path or `path#name`. Domains name their facets in it and rules their
// subjects, so both are checked, and matched, alike.

const DRIVE = /^[A-Za-z]:/;
/** Kept for patterns, so that adding them later changes no facet's meaning. */
const RESERVED = /[*?]|^!/;
/** A JavaScript identifier, as `getName()` returns a top-level declaration's name. */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/** What is wrong with a facet, as the configuration error says it; undefined when nothing is. */
function facetIssue(facet: string): string | undefined {
  if (facet === "") {
    return "must be a workspace-relative path";
  }
  if (facet.trim() !== facet) {
    return "must have no leading or trailing whitespace";
  }
  if (facet.includes("\\")) {
    return 'must use "/" as the separator';
  }
  if (facet.startsWith("/") || DRIVE.test(facet)) {
    return "must be relative to the workspace root";
  }
  if (RESERVED.test(facet)) {
    return 'must not use "*", "?", or a leading "!", which are reserved for patterns';
  }
  const [path = "", symbol, ...rest] = facet.split("#");
  if (rest.length > 0) {
    return 'must name at most one symbol, after one "#"';
  }
  if (path === "" && symbol !== undefined) {
    return 'must name a file before "#"';
  }
  if (
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return 'must have no empty, ".", or ".." segments, and no trailing "/"';
  }
  if (symbol !== undefined && !IDENTIFIER.test(symbol)) {
    return 'must name one top-level declaration after "#"';
  }
}

/** One facet, as a configuration file writes it. */
export const facetSchema = z
  .string({ error: "must be a workspace-relative path" })
  .superRefine((facet, context) => {
    const message = facetIssue(facet);
    if (message !== undefined) {
      context.addIssue({ code: "custom", input: facet, message });
    }
  });
