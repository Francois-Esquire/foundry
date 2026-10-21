/**
 * The TextMate grammars the extension contributes, built from shared regex
 * fragments that mirror `@foundry/prompts`' notations. Notations match with
 * code, so this cannot be derived from them; the grammar tests compare what
 * these highlight against what the parser reads. `bun run grammar` writes
 * them to `syntaxes/`.
 */

import { HIGHLIGHT_SCOPES as SCOPE } from "@foundry/prompts";

type Rule = Record<string, unknown>;

/** A sigil sits at the start of a line or after whitespace, an opening bracket or quote, or a separator. */
const BOUNDARY = "(?<![^\\s(\\[{<\"',;`])";
const SEGMENT = "[A-Za-z0-9](?:[\\w-]*[A-Za-z0-9])?";
/** Atomic, because the scanner never backtracks into a name. */
const NAME = `(?>${SEGMENT}(?::${SEGMENT})*)`;
/** A listed name ends exactly where the scanner's name would, and is not a path. */
const NAME_END = "(?![\\w-]*[A-Za-z0-9]|:[A-Za-z0-9])(?!/)";
const TRAILING = ".,;:!?)\\]}>";
/** Where a message opens: right after the opening backtick or quote, on its line. */
const OPENING = "\\G\\s*";
const QUALIFIER = "((?:[$_A-Za-z][$\\w]*\\s*\\??\\.\\s*)+)";
const SCHEMA =
  "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json";

/** Snapshots of each harness's built-in commands, as in `src/dialects/`. */
const CLAUDE_CODE_COMMANDS = [
  "add-dir",
  "agents",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "export",
  "fast",
  "help",
  "hooks",
  "init",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "permissions",
  "plugin",
  "pr-comments",
  "resume",
  "review",
  "rewind",
  "status",
  "terminal-setup",
  "usage",
  "vim",
];
const PI_COMMANDS = [
  "changelog",
  "clear",
  "compact",
  "copy",
  "exit",
  "export",
  "fork",
  "hotkeys",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "session",
  "settings",
  "share",
  "tree",
];

const listed = (names: readonly string[]): string =>
  `(?:${names.join("|")})${NAME_END}`;

const opening = (pattern: string, scope: string): Rule => ({
  captures: { 1: { name: scope } },
  match: `${OPENING}(${pattern})`,
});

/** `!command` opening the message, up to the end of the line, the closing quote, or a substitution. */
const shellLine = (closing: string): Rule =>
  opening(`!(?!\`)(?:(?!\\$\\{)(?:[^${closing}\\\\]|\\\\.))+`, SCOPE.shell);

/** The repository shared by every host: what each dialect reads anywhere in a message, and in a template. */
const prompt: Rule = {
  $schema: SCHEMA,
  name: "Prompt",
  patterns: [{ include: "#claude-code-template" }],
  repository: {
    "agent-mention": {
      match: `${BOUNDARY}@"[^"]+? \\(agent\\)"`,
      name: SCOPE.agent,
    },
    "claude-code-message": {
      patterns: [
        { include: "#slash-skill" },
        { include: "#agent-mention" },
        { include: "#file-mention" },
        {
          match: `${BOUNDARY}\\$(?:ARGUMENTS(?![\\w\\[])|ARGUMENTS\\[\\d+\\]|\\d+(?!\\w)|[a-z][\\w-]*(?![\\w-]))`,
          name: SCOPE.argument,
        },
      ],
    },
    "claude-code-template": {
      patterns: [
        { include: "#claude-code-message" },
        { include: "#variable" },
        { include: "#inline-shell" },
      ],
    },
    "codex-message": {
      patterns: [
        { match: "\\$\\$(?!\\{)", name: SCOPE.escape },
        { include: "#file-mention" },
        {
          match: `${BOUNDARY}\\$(?:ARGUMENTS(?![\\w\\[])|ARGUMENTS\\[\\d+\\]|\\d+(?!\\w)|[A-Z][A-Z0-9_]*(?![\\w-]))`,
          name: SCOPE.argument,
        },
        { match: `${BOUNDARY}\\$${NAME}(?!/)`, name: SCOPE.skill },
      ],
    },
    "escaped-inline-shell": {
      match: `${BOUNDARY}!\\\\\`(?:[^\`\\\\]|\\\\[^\`])*?\\S(?:[^\`\\\\]|\\\\[^\`])*?\\\\\``,
      name: SCOPE.shell,
    },
    "escaped-variable": {
      match: "\\\\\\$\\{[A-Za-z_]\\w*\\}",
      name: SCOPE.variable,
    },
    "file-mention": {
      // A path never takes a quote, a backtick, or a substitution, so it cannot run past the end of its string.
      match: `${BOUNDARY}@(?:(?!\\$\\{)[^\\s\`"'])*?(?:(?!\\$\\{)[^\\s\`"'${TRAILING}])(?=[${TRAILING}]*(?:[\\s\`"']|\\$\\{|$))`,
      name: SCOPE.file,
    },
    "inline-shell": {
      match: `${BOUNDARY}!\`[^\`]*?\\S[^\`]*?\``,
      name: SCOPE.shell,
    },
    "pi-message": {
      patterns: [
        { include: "#file-mention" },
        { match: `${BOUNDARY}\\$(?:@|\\d+(?!\\w))`, name: SCOPE.argument },
      ],
    },
    "slash-skill": {
      match: `${BOUNDARY}/${NAME}(?!/)`,
      name: SCOPE.skill,
    },
    variable: { match: "\\$\\{[A-Za-z_]\\w*\\}", name: SCOPE.variable },
  },
  scopeName: "text.prompt",
};

interface DialectRules {
  /** The member a tag is read from: `prompts.claude`. */
  readonly member: string;
  /** What only opens a message; `closing` is the characters that end the string. */
  opening(closing: string): Rule[];
  /** Template-only notation as it is written inside a template literal, and inside a quoted string. */
  readonly template: { readonly literal: Rule[]; readonly quoted: Rule[] };
}

const DIALECTS: Record<string, DialectRules> = {
  "claude-code": {
    member: "claude",
    opening: () => [opening(`/${listed(CLAUDE_CODE_COMMANDS)}`, SCOPE.command)],
    template: {
      literal: [
        { include: "text.prompt#escaped-variable" },
        { include: "text.prompt#escaped-inline-shell" },
      ],
      quoted: [
        { include: "text.prompt#variable" },
        { include: "text.prompt#inline-shell" },
      ],
    },
  },
  codex: {
    member: "codex",
    opening: (closing) => [
      opening(`/prompts:${NAME}(?!/)`, SCOPE.template),
      opening(`/${NAME}(?!/)`, SCOPE.command),
      shellLine(closing),
    ],
    template: { literal: [], quoted: [] },
  },
  pi: {
    member: "pi",
    opening: (closing) => [
      opening(`/skill:${NAME}(?!/)`, SCOPE.skill),
      opening(`/${listed(PI_COMMANDS)}`, SCOPE.command),
      opening(`/${NAME}(?!/)`, SCOPE.template),
      shellLine(closing),
    ],
    template: { literal: [], quoted: [] },
  },
};

/** Tagged templates (`prompts.claude\`…\``) and plain-string calls (`prompts.codex("…")`) in JS and TS. */
function typescript(): Rule {
  const repository: Record<string, Rule> = {
    escape: {
      match: "\\\\(?:x[0-9A-Fa-f]{2}|u\\{[0-9A-Fa-f]+\\}|u[0-9A-Fa-f]{4}|.)",
      name: "constant.character.escape.ts",
    },
  };
  const patterns: Rule[] = [];
  for (const [id, dialect] of Object.entries(DIALECTS)) {
    repository[`${id}-template`] = {
      begin: `\\b${QUALIFIER}(${dialect.member})\\s*(\`)`,
      beginCaptures: {
        1: { name: "variable.other.object.ts" },
        2: { name: "entity.name.function.tagged-template.ts" },
        3: {
          name: "string.template.ts punctuation.definition.string.template.begin.ts",
        },
      },
      contentName: `string.template.ts meta.prompt.${id}`,
      end: "`",
      endCaptures: {
        0: {
          name: "string.template.ts punctuation.definition.string.template.end.ts",
        },
      },
      patterns: [
        ...dialect.opening("`"),
        ...dialect.template.literal,
        { include: "#escape" },
        { include: "source.ts#template-substitution-element" },
        { include: `text.prompt#${id}-message` },
      ],
    };
    repository[`${id}-call`] = {
      begin: `\\b${QUALIFIER}(${dialect.member})\\s*(\\()\\s*(["'])`,
      beginCaptures: {
        1: { name: "variable.other.object.ts" },
        2: { name: "entity.name.function.ts" },
        3: { name: "meta.brace.round.ts" },
        4: { name: "string.quoted.ts punctuation.definition.string.begin.ts" },
      },
      contentName: `string.quoted.ts meta.prompt.${id}`,
      end: "\\4",
      endCaptures: {
        0: { name: "string.quoted.ts punctuation.definition.string.end.ts" },
      },
      patterns: [
        ...dialect.opening("\"'"),
        ...dialect.template.quoted,
        { include: "#escape" },
        { include: `text.prompt#${id}-message` },
      ],
    };
    patterns.push({ include: `#${id}-template` }, { include: `#${id}-call` });
  }
  return {
    $schema: SCHEMA,
    // `-(string -meta.embedded)` keeps the injection live inside `${}` (TypeScript's `meta.embedded.line.ts`), where the template's string scope is still on the stack.
    // The prompt body itself carries no `meta.embedded`: VS Code would read it as code and match brackets and close quotes in prose.
    injectionSelector: "L:source -comment -(string -meta.embedded)",
    patterns,
    repository,
    scopeName: "inline.prompts.typescript",
  };
}

/** The body of SKILL.md, agent, rule, and prompt files, read as a Claude Code template. */
const markdown: Rule = {
  $schema: SCHEMA,
  injectionSelector:
    "L:text.html.markdown.prompt -comment -markup.fenced_code -markup.raw -markup.inline.raw -markup.underline.link -meta.embedded",
  patterns: [{ include: "text.prompt#claude-code-template" }],
  scopeName: "inline.prompts.markdown",
};

/** Each grammar by its path in `syntaxes/`, as the manifest contributes it. */
export function grammars(): Record<string, Rule> {
  return {
    "prompt.tmLanguage.json": prompt,
    "prompts.markdown.tmLanguage.json": markdown,
    "prompts.typescript.tmLanguage.json": typescript(),
  };
}
