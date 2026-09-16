import type { ToolSet } from "ai";

import { tool } from "ai";
import { z } from "zod";
import { tagTools } from "../harness/types";
import type { Skill, SkillFile, SkillRegistry } from "./types";

/**
 * Create an in-memory {@link SkillRegistry}. The registry holds a set of
 * available skills and projects them into what an agent harness consumes:
 *
 *   - `tools`        — exactly two meta-tools, `list_skills` and `load_skill`.
 *                      Skills are *not* one tool each; the model discovers them
 *                      with `list_skills` and pulls a skill's full instructions
 *                      with `load_skill` — load on demand.
 *   - `instructions` — a preamble plus a one-line catalog (name + description)
 *                      of every available skill, so the prompt stays small while
 *                      the model still knows what it can load. Memoized.
 *
 * It is deliberately source-agnostic: it never touches the filesystem or any
 * I/O. Hand it {@link Skill}s from anywhere — a virtual object, a JSON
 * definition, or `defineSkill()` over a manifest a host read for you — and
 * wire it into a harness:
 *
 * ```ts
 * const registry = createSkillRegistry(skills);
 * new SessionHarness({
 *   tools: { ...baseTools, ...registry.tools },
 *   instructions: `${BASE_PROMPT}\n\n${registry.instructions}`,
 * }, { sessionId: "" });
 * ```
 *
 * `add`/`remove` change the available set at any time, so a long-running agent
 * can grow or shrink the skills it can reach between turns.
 */
export function createSkillRegistry(skills: Skill[] = []): SkillRegistry {
  // Available skills, keyed by name; a Map preserves registration order.
  const available = new Map<string, Skill>();

  // The catalog preamble is memoized — null means "stale, recompute on read".
  let instructionsMemo: string | null = null;

  function list(): Skill[] {
    return [...available.values()];
  }

  // The two meta-tools are the registry's whole tool surface. They are built
  // once; their `execute` reads the live `available` map, so `add`/`remove` is
  // reflected without rebuilding the tools.
  const tools: ToolSet = tagTools(
    {
      list_skills: tool({
        description:
          "List the skills available to load. Returns each skill's name and a description of when it applies. Use this to discover skills before loading one with load_skill.",
        execute: () =>
          list().map((skill) => ({
            description: skill.description,
            name: skill.name,
          })),
        inputSchema: z.object({}),
      }),
      load_skill: tool({
        description:
          "Load a skill by name to get its instructions and an index of the files it bundles. Pass `file` (a name from that index) to instead get that one file's contents. Call list_skills first to see the names; load a skill before acting on a task it covers.",
        execute: ({ name, file }) => {
          const skill = available.get(name);
          if (!skill) {
            const names = [...available.keys()];
            return `No skill named "${name}". Available: ${
              names.length > 0 ? names.join(", ") : "(none)"
            }.`;
          }
          // Models often send `file: ""` for "no file"; read that as omitted.
          const fileName = file?.trim();
          if (fileName) {
            const file = fileName;
            const content = skill.files?.[file];
            if (content === undefined) {
              const keys = Object.keys(skill.files ?? {});
              return `Skill "${name}" has no file "${file}". Files: ${
                keys.length > 0 ? keys.join(", ") : "(none)"
              }.`;
            }
            return renderFile(file, content);
          }
          return renderSkill(skill);
        },
        inputSchema: z.object({
          file: z
            .string()
            .optional()
            .describe(
              "Optional: a file name from the skill's file index, to return that file's contents. Omit to get the skill's instructions and file index."
            ),
          name: z
            .string()
            .describe("The skill name, exactly as returned by list_skills."),
        }),
      }),
    },
    "skill"
  );

  const registry: SkillRegistry = {
    add(...incoming) {
      if (incoming.length === 0) {
        return registry;
      }
      for (const skill of incoming) {
        // Re-adding a name replaces it, moving the latest to the end of `list`.
        available.delete(skill.name);
        available.set(skill.name, skill);
      }
      instructionsMemo = null;
      return registry;
    },
    get(name) {
      return available.get(name);
    },
    get instructions() {
      return (instructionsMemo ??= computeInstructions(list()));
    },
    list,
    remove(name) {
      if (available.delete(name)) {
        instructionsMemo = null;
      }
      return registry;
    },
    get tools() {
      return tools;
    },
  };

  return registry.add(...skills);
}

/** The system-prompt augmentation: a preamble plus the name/description catalog. */
function computeInstructions(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const catalog = skills
    .map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    "## Skills",
    "You have skills available — self-contained capabilities, each with its own instructions and bundled files. When a task matches one, call `load_skill` with its name to load its full instructions before proceeding; call `list_skills` to see the catalog at any time.",
    `Available skills:\n${catalog}`,
  ].join("\n\n");
}

/** What `load_skill({ name })` returns: the instructions and an index of file names. */
function renderSkill(skill: Skill): string {
  const parts: string[] = [`# Skill: ${skill.name}`];
  if (skill.description.trim()) {
    parts.push(skill.description.trim());
  }
  if (skill.instructions?.trim()) {
    parts.push(skill.instructions.trim());
  }

  const names = Object.keys(skill.files ?? {});
  if (names.length > 0) {
    const lines = names.map((name) => `- ${name}`).join("\n");
    parts.push(
      `## Files\nThis skill bundles these files. Request one with \`load_skill({ name: "${skill.name}", file })\`:\n${lines}`
    );
  }

  return parts.join("\n\n");
}

/** What `load_skill({ name, file })` returns: that file's contents (bytes decoded as UTF-8). */
function renderFile(name: string, content: SkillFile): string {
  const text =
    typeof content === "string" ? content : new TextDecoder().decode(content);
  return `# File: ${name}\n\n${text}`;
}
