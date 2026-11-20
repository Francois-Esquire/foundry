import { HIGHLIGHT_SCOPES as SCOPE } from "@foundry/prompts";

type Rule = Record<string, unknown>;

const BOUNDARY = "(?<![^\\s(\\[{<\"',;`])";
const SEGMENT = "[A-Za-z0-9](?:[\\w-]*[A-Za-z0-9])?";
const NAME = `(?>${SEGMENT}(?::${SEGMENT})*)`;
const NAME_END = "(?![\\w-]*[A-Za-z0-9]|:[A-Za-z0-9])(?!/)";
const TRAILING = ".,;:!?)\\]}>";
const OPENING = "\\G\\s*";
const QUALIFIER = "((?:[$_A-Za-z][$\\w]*\\s*\\??\\.\\s*)+)";
const SCHEMA =
  "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json";

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

const shellLine = (closing: string): Rule =>
  opening(`!(?!\`)(?:(?!\\$\\{)(?:[^${closing}\\\\]|\\\\.))+`, SCOPE.shell);

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
      match: `${BOUNDARY}!\\\\\`(?:(?!\\s*+(?:\\\\\\\\)*+\\\\\`)[^\`]*+(?<=\\\\)\`|[^\`]*+(?<!\\\\)\`(?:[^\`\\\\]|\\\\[^\`])*+\\\\\`)`,
      name: SCOPE.shell,
    },
    "escaped-variable": {
      match: "\\\\\\$\\{[A-Za-z_]\\w*\\}",
      name: SCOPE.variable,
    },
    "file-mention": {
      match: `${BOUNDARY}@(?:(?!\\$\\{)[^\\s\`"'])*?(?:(?!\\$\\{)[^\\s\`"'${TRAILING}])(?=[${TRAILING}]*(?:[\\s\`"']|\\$\\{|$))`,
      name: SCOPE.file,
    },
    "inline-shell": {
      match: `${BOUNDARY}!\`\\s*+[^\\s\`][^\`]*+\``,
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
  readonly member: string;
  opening(closing: string): Rule[];
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
    injectionSelector: "L:source -comment -(string -meta.embedded)",
    patterns,
    repository,
    scopeName: "inline.prompts.typescript",
  };
}

const markdown: Rule = {
  $schema: SCHEMA,
  injectionSelector:
    "L:text.html.markdown.prompt -comment -markup.fenced_code -markup.raw -markup.inline.raw -markup.underline.link -meta.embedded",
  patterns: [{ include: "text.prompt#claude-code-template" }],
  scopeName: "inline.prompts.markdown",
};

export function grammars(): Record<string, Rule> {
  return {
    "prompt.tmLanguage.json": prompt,
    "prompts.markdown.tmLanguage.json": markdown,
    "prompts.typescript.tmLanguage.json": typescript(),
  };
}
