import { createHash } from "node:crypto";
import { canonicalizeJson } from "@foundry/lib/json";
import type { Output } from "ai";
import { catalog } from "~/authoring/catalog";
import type { AgentDeclaration, DefineAgent } from "~/authoring/instances";
import {
  agentInstance,
  artifactInstance,
  recipeInstance,
  sandboxInstance,
  workspaceInstance,
} from "~/authoring/instances";
import type {
  Agent,
  ArtifactInstance,
  DeferredAgent,
  SandboxInstance,
  SandboxSpec,
  SkillOp,
  SkillSet,
  WorkspaceInstance,
} from "~/lib/types";

import { bindingAt, callSite, originOf } from "./identity";

/**
 * The definition words. Each is a preset with defaults; the context creates
 * the same things on the spot.
 *
 * An agent's id is durable: approvals granted "for future runs" and the
 * triggers it creates are filed under it, so it must not move when the
 * config is edited around it. It is the name given, else the top-level
 * `const` the call is assigned to, else a digest of its prompt. The route
 * is not part of it: `extend` keeps the id on another route. Workspaces,
 * sandboxes and artifacts keep registration-order ids: nothing durable is
 * keyed by them.
 *
 * An agent declared with a function is named by its `const`, else a
 * digest of the function's source. The function runs as each session
 * opens, never on import, and returns the rest of the definition. Its id
 * belongs to that one function: another function claiming it, even one
 * with the same source, is refused rather than merged.
 */

/** The id a declaration claims: the name, else its `const`, else its digest. */
function claimAgentId(
  name: string | undefined,
  digest: string,
  define?: object
): string {
  const site = callSite();
  const id =
    name ??
    (site === undefined ? undefined : bindingAt(site)) ??
    `agent-${digest.slice(0, 16)}`;
  catalog.claimAgent(id, digest, site && originOf(site), define);
  return id;
}

/** An agent declared with a function: claimed now, built as each session opens. */
function agentFromFunction<OUTPUT extends Output.Output>(
  define: DefineAgent<OUTPUT>
): DeferredAgent<OUTPUT> {
  const digest = createHash("sha256")
    .update(canonicalizeJson(["function", define.toString()]))
    .digest("hex");
  const id = claimAgentId(undefined, digest, define);
  const definition = recipeInstance<OUTPUT>({
    define: define as unknown as DefineAgent<Output.Output>,
    id,
    route: {},
    settings: [],
  });
  catalog.agents.set(id, definition as DeferredAgent<Output.Output>);
  return definition;
}

/** An agent from its definition: complete, and usable at once. */
export function agent<OUTPUT extends Output.Output = never>(
  spec: AgentDeclaration<OUTPUT>
): Agent<OUTPUT>;
/**
 * An agent from a function that returns its definition as each session
 * opens: it can read `usage`, pick a route, and choose skills and MCP
 * servers for it. Until then it is not a definition.
 */
export function agent<OUTPUT extends Output.Output = never>(
  define: DefineAgent<OUTPUT>
): DeferredAgent<OUTPUT>;
export function agent<OUTPUT extends Output.Output = never>(
  spec: AgentDeclaration<OUTPUT> | DefineAgent<OUTPUT>
): Agent<OUTPUT> | DeferredAgent<OUTPUT> {
  if (typeof spec === "function") {
    return agentFromFunction(spec);
  }
  const { name, ...rest } = spec;
  if (!rest.prompt.trim()) {
    throw new Error("agent(): a prompt is required");
  }
  if (name?.trim() === "") {
    throw new Error("agent(): a name cannot be blank");
  }
  const digest = createHash("sha256")
    .update(canonicalizeJson([rest.prompt]))
    .digest("hex");
  const id = claimAgentId(name, digest);
  const definition = agentInstance<OUTPUT>({ id, kind: "agent", ...rest });
  catalog.agents.set(id, definition as Agent<Output.Output>);
  return definition;
}

export function workspace(spec: { readonly path: string }): WorkspaceInstance {
  if (!spec.path.trim()) {
    throw new Error("workspace(): a path is required");
  }
  catalog.workspaces.add(spec.path);
  return workspaceInstance({
    id: catalog.claimId("workspace"),
    kind: "workspace",
    path: spec.path,
  });
}

export function sandbox(spec: SandboxSpec): SandboxInstance {
  if ("files" in spec && Object.keys(spec.files).length === 0) {
    throw new Error("sandbox({ files }): give it at least one file");
  }
  return sandboxInstance({
    id: catalog.claimId("sandbox"),
    kind: "sandbox",
    ...spec,
  });
}

export function artifact(spec: {
  readonly name: string;
  readonly type: string;
}): ArtifactInstance {
  if (!(spec.name.trim() && spec.type.trim())) {
    throw new Error("artifact(): a name and a type are required");
  }
  return artifactInstance({
    id: catalog.claimId("artifact"),
    kind: "artifact",
    ...spec,
  });
}

function skillSet(ops: readonly SkillOp[]): SkillSet {
  return {
    add(source) {
      if (typeof source !== "string") {
        if (!source.name.trim()) {
          throw new Error("skills.add(): a skill needs a name");
        }
        return skillSet([...ops, { kind: "skill", skill: source }]);
      }
      if (!source.trim()) {
        throw new Error("skills.add(): a glob is required");
      }
      return skillSet([...ops, { glob: source, kind: "add" }]);
    },
    kind: "skills",
    ops,
    pick(...names) {
      if (names.length === 0) {
        throw new Error("skills.pick(): name at least one skill");
      }
      return skillSet([...ops, { kind: "pick", names }]);
    },
  };
}

export const skills = {
  /** The global and workspace skills. Chain `.add(glob)` and `.pick(...)`. */
  load(): SkillSet {
    return skillSet([{ kind: "load" }]);
  },
  /** No skills yet: start a set from only what `.add` gives it. */
  none(): SkillSet {
    return skillSet([]);
  },
};
