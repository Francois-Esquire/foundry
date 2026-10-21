import { readFileSync } from "node:fs";
import { HIGHLIGHT_SCOPES, type TokenKind } from "@foundry/prompts";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import markdown from "shiki/langs/markdown.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import darkPlus from "shiki/themes/dark-plus.mjs";
import githubDarkDefault from "shiki/themes/github-dark-default.mjs";
import githubLightDefault from "shiki/themes/github-light-default.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";

interface GrammarContribution {
  readonly injectTo?: string[];
  readonly path: string;
  readonly scopeName: string;
}

interface Manifest {
  readonly contributes: { readonly grammars: readonly GrammarContribution[] };
}

const root = new URL("../../../", import.meta.url);

/** What the editor shows: one highlighted reference, with the kind its scope stands for. */
export interface Highlight {
  readonly kind: TokenKind;
  readonly text: string;
}

const KIND_BY_SCOPE = new Map(
  Object.entries(HIGHLIGHT_SCOPES).map(([kind, scope]) => [
    scope,
    kind as TokenKind,
  ])
);

/** Every grammar the manifest contributes, registered the way VS Code reads it. */
export function contributedGrammars(): LanguageRegistration[] {
  const manifest = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8")
  ) as Manifest;
  return manifest.contributes.grammars.map((contribution) => ({
    ...JSON.parse(readFileSync(new URL(contribution.path, root), "utf8")),
    injectTo: contribution.injectTo,
    name: contribution.scopeName,
  }));
}

/**
 * VS Code's built-in `prompt-basics` gives SKILL.md and agent files a root
 * grammar that only wraps markdown. Injections are collected for the root
 * scope, so this is what the markdown injection has to reach.
 */
const promptMarkdown: LanguageRegistration = {
  embeddedLangs: ["markdown"],
  name: "skill",
  patterns: [{ include: "text.html.markdown" }],
  repository: {},
  scopeName: "text.html.markdown.prompt",
};

/** Shiki's copies of VS Code's Dark+ and Light+, and the GitHub themes VS Code's 2026 themes take their palette from. */
const THEME_REGISTRATIONS = [
  darkPlus,
  lightPlus,
  githubDarkDefault,
  githubLightDefault,
];
export const THEMES = [
  "dark-plus",
  "light-plus",
  "github-dark-default",
  "github-light-default",
] as const;
export type Theme = (typeof THEMES)[number];

let loading: Promise<HighlighterCore> | undefined;

function highlighter(): Promise<HighlighterCore> {
  loading ??= createHighlighterCore({
    engine: createOnigurumaEngine(import("shiki/wasm")),
    langs: [
      ...typescript,
      // VS Code always has YAML; without it markdown drops its frontmatter rule.
      ...yaml,
      ...markdown,
      promptMarkdown,
      ...contributedGrammars(),
    ],
    themes: THEME_REGISTRATIONS,
  });
  return loading;
}

/** One run of text as a theme paints it. */
export interface Painted {
  readonly color: string;
  /** The prompt kind its scopes stand for; none for the host's own text. */
  readonly kind?: TokenKind;
  readonly text: string;
}

/** `source` as `theme` colours it, token by token. */
export async function paint(
  language: "skill" | "typescript",
  source: string,
  theme: Theme
): Promise<Painted[]> {
  const { tokens } = (await highlighter()).codeToTokens(source, {
    includeExplanation: true,
    lang: language,
    theme,
  });
  return tokens.flat().map((token) => ({
    color: token.color ?? "",
    kind: token.explanation
      ?.flatMap((part) => part.scopes)
      .map(({ scopeName }) => KIND_BY_SCOPE.get(scopeName))
      .filter((candidate) => candidate !== undefined)
      .at(-1),
    text: token.content,
  }));
}

/** A theme's default text colour. */
export async function foreground(theme: Theme): Promise<string> {
  return (await highlighter()).getTheme(theme).fg;
}

/**
 * The prompt references a language's grammar, with the contributed
 * injections, highlights in `source`. Scopes outside `HIGHLIGHT_SCOPES`
 * (the host language's own) are dropped.
 */
export async function highlight(
  language: "markdown" | "skill" | "typescript",
  source: string
): Promise<Highlight[]> {
  const grammar = (await highlighter()).getLanguage(language);
  const found: Highlight[] = [];
  let state: Parameters<typeof grammar.tokenizeLine>[1] = null;
  for (const line of source.split("\n")) {
    const { ruleStack, tokens } = grammar.tokenizeLine(line, state);
    for (const token of tokens) {
      const kind = token.scopes
        .map((scope) => KIND_BY_SCOPE.get(scope))
        .filter((candidate) => candidate !== undefined)
        .at(-1);
      if (kind !== undefined) {
        found.push({
          kind,
          text: line.slice(token.startIndex, token.endIndex),
        });
      }
    }
    state = ruleStack;
  }
  return found;
}

const TOKEN_TYPES = ["other", "comment", "string", "regex"] as const;
/** vscode-textmate packs the token type into bits 8 and 9 of each token's metadata. */
const TOKEN_TYPE_UNIT = 2 ** 8;

/** One run of text with the type VS Code gives it, which decides bracket matching and auto-closing. */
export interface Typed {
  readonly text: string;
  readonly type: (typeof TOKEN_TYPES)[number];
}

/** `source` split into runs by the standard token type its grammar gives each. */
export async function tokenTypes(
  language: "typescript",
  source: string
): Promise<Typed[]> {
  const grammar = (await highlighter()).getLanguage(language);
  const found: Typed[] = [];
  let state: Parameters<typeof grammar.tokenizeLine2>[1] = null;
  for (const line of source.split("\n")) {
    const { ruleStack, tokens } = grammar.tokenizeLine2(line, state);
    for (let index = 0; index < tokens.length; index += 2) {
      const start = tokens[index] ?? 0;
      const end = tokens[index + 2] ?? line.length;
      const metadata = tokens[index + 1] ?? 0;
      found.push({
        text: line.slice(start, end),
        type:
          TOKEN_TYPES[
            Math.floor(metadata / TOKEN_TYPE_UNIT) % TOKEN_TYPES.length
          ] ?? "other",
      });
    }
    state = ruleStack;
  }
  return found;
}
