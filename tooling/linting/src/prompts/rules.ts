import { check, type Diagnostic, type DiagnosticCode } from "@foundry/prompts";
import type { Context, CreateOnceRule, ESTree } from "@oxlint/plugins";
import { promptOf } from "./nodes";
import { resolveSettings } from "./settings";

type Candidate = ESTree.CallExpression | ESTree.TaggedTemplateExpression;

/** A diagnostic with its span mapped to file offsets. */
interface Located {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly range: readonly [number, number];
}

/**
 * One check per prompt node, shared by every rule: the first rule to visit a
 * node computes its findings, the others read them. A node belongs to one
 * file, so the cache cannot go stale across files; it is recomputed when
 * the settings object differs, as under another config.
 */
const checked = new WeakMap<
  Candidate,
  { settings: unknown; found: readonly Located[] }
>();

function findingsFor(node: Candidate, context: Context): readonly Located[] {
  const { settings } = context;
  const hit = checked.get(node);
  if (hit !== undefined && hit.settings === settings) {
    return hit.found;
  }
  const resolved = resolveSettings(settings, context.cwd);
  const prompt = promptOf(node, resolved.dialects, context.sourceCode.text);
  const found: Located[] =
    prompt === null
      ? []
      : check(prompt.dialect, prompt.chunks, {
          sources: resolved.sources,
          surface: resolved.surface,
        }).map((item: Diagnostic) => ({
          code: item.code,
          message: item.message,
          range: prompt.toSource(item.span.start, item.span.end),
        }));
  checked.set(node, { found, settings });
  return found;
}

export interface RuleSpec {
  readonly code: DiagnosticCode;
  readonly description: string;
  readonly name: string;
}

/** One rule per diagnostic code a rule can see in source, named after the code. The two codes about interpolated values need the value, so no rule reports them. */
export const RULES: readonly RuleSpec[] = [
  {
    code: "unresolved-reference",
    description:
      "A skill, agent, command, or variable that nothing configured and no built-in has.",
    name: "unresolved-reference",
  },
  {
    code: "foreign-notation",
    description:
      "A skill or agent the host has, written in another harness's notation.",
    name: "foreign-notation",
  },
  {
    code: "template-only",
    description:
      "Notation the harness substitutes only inside a skill or template file, found in a message.",
    name: "template-only",
  },
  {
    code: "consumed-by-harness",
    description:
      "A message the harness handles itself, so the model never receives it.",
    name: "consumed-by-harness",
  },
];

const DOCS =
  "https://github.com/Francois-Esquire/foundry/tree/main/tooling/linting";

/** One rule per diagnostic code, so severity is set per code. */
export function rule(spec: RuleSpec): CreateOnceRule {
  return {
    createOnce(context) {
      const visit = (node: Candidate): void => {
        for (const item of findingsFor(node, context)) {
          if (item.code !== spec.code) {
            continue;
          }
          const { sourceCode } = context;
          context.report({
            loc: {
              end: sourceCode.getLocFromIndex(item.range[1]),
              start: sourceCode.getLocFromIndex(item.range[0]),
            },
            message: item.message,
          });
        }
      };
      return { CallExpression: visit, TaggedTemplateExpression: visit };
    },
    meta: {
      docs: {
        description: spec.description,
        url: `${DOCS}#prompts${spec.name}`,
      },
      schema: [],
      type: "problem",
    },
  };
}
