import { z } from "zod";

const DRIVE = /^[A-Za-z]:/;
const RESERVED = /[*?]|^!/;
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

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

export const facetSchema = z
  .string({ error: "must be a workspace-relative path" })
  .superRefine((facet, context) => {
    const message = facetIssue(facet);
    if (message !== undefined) {
      context.addIssue({ code: "custom", input: facet, message });
    }
  });
