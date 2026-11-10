/**
 * Where accepted candidates go next: a text that sets them, for Proof, and
 * the writing system they belong to, for an export of that subset. Both are
 * read from the candidates themselves, so the links carry what was made and
 * not what the request happens to say now.
 */
import { type Scope, scopeOf } from "~/unicode/scope";

export interface NextSteps {
  /** The writing system every accepted character belongs to. Absent when they are of several. */
  readonly scope?: Scope;
  /** The accepted characters with a space between them. Empty when none has a character. */
  readonly text: string;
}

const sameScope = (a: Scope | undefined, b: Scope | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/** `characters` are the characters of the candidates now in the face. */
export const nextStepsFor = (characters: readonly number[]): NextSteps => {
  const distinct = [...new Set(characters)];
  const scopes = distinct.map(scopeOf);
  const [first] = scopes;
  return {
    scope: scopes.every((scope) => sameScope(scope, first)) ? first : undefined,
    text: distinct.map((code) => String.fromCodePoint(code)).join(" "),
  };
};
