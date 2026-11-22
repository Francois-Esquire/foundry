import { createHash } from "node:crypto";
import { canonicalizeJson } from "@foundry/lib/json";
import type { Output } from "ai";
import type { AgentDeclaration, DefineAgent } from "~/authoring/instances";
import {
  agentInstance,
  artifactInstance,
  promptFields,
  recipeInstance,
  sandboxInstance,
  workspaceInstance,
} from "~/authoring/instances";
import { declaringCatalog } from "~/authoring/runtime";
import {
  ARTIFACTS,
  observable,
  SANDBOXES,
  SESSIONS,
  WORKSPACES,
} from "~/lib/events/source";
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
  declaringCatalog().claimAgent(id, digest, site && originOf(site), define);
  return id;
}

function checkedName(name: string | undefined): string | undefined {
  if (name !== undefined && name.trim() === "") {
    throw new Error("agent(): a name cannot be blank");
  }
  return name;
}

function agentFromFunction<OUTPUT extends Output.Output, INPUT>(
  name: string | undefined,
  define: DefineAgent<OUTPUT, INPUT>
): DeferredAgent<OUTPUT, INPUT> {
  if (typeof define !== "function") {
    throw new TypeError(
      `agent(${JSON.stringify(name)}): give it the function that defines it`
    );
  }
  const digest = createHash("sha256")
    .update(canonicalizeJson(["function", define.toString()]))
    .digest("hex");
  const id = claimAgentId(name, digest, define);
  const definition = recipeInstance<OUTPUT, INPUT>({
    define: define as unknown as DefineAgent<Output.Output, unknown>,
    id,
    route: {},
    settings: [],
  });
  declaringCatalog().agents.set(
    id,
    definition as unknown as DeferredAgent<Output.Output, unknown>
  );
  return definition;
}

export function agent<OUTPUT extends Output.Output = never>(
  spec: AgentDeclaration<OUTPUT>
): Agent<OUTPUT>;
export function agent<OUTPUT extends Output.Output = never, INPUT = undefined>(
  define: DefineAgent<OUTPUT, INPUT>
): DeferredAgent<OUTPUT, INPUT>;
export function agent<OUTPUT extends Output.Output = never, INPUT = undefined>(
  name: string,
  define: DefineAgent<OUTPUT, INPUT>
): DeferredAgent<OUTPUT, INPUT>;
export function agent<OUTPUT extends Output.Output = never, INPUT = undefined>(
  spec: AgentDeclaration<OUTPUT> | DefineAgent<OUTPUT, INPUT> | string,
  define?: DefineAgent<OUTPUT, INPUT>
): Agent<OUTPUT> | DeferredAgent<OUTPUT, INPUT> {
  if (typeof spec === "string") {
    return agentFromFunction(checkedName(spec), define as never);
  }
  if (typeof spec === "function") {
    return agentFromFunction(undefined, spec);
  }
  const { name: given, prompt, ...rest } = spec;
  const fields = promptFields(prompt);
  if (!fields.prompt.trim()) {
    throw new Error("agent(): a prompt is required");
  }
  const name = checkedName(given);
  const digest = createHash("sha256")
    .update(
      canonicalizeJson(
        typeof prompt === "string" ? [prompt] : ["portable", prompt.key]
      )
    )
    .digest("hex");
  const id = claimAgentId(name, digest);
  const definition = agentInstance<OUTPUT>({
    id,
    kind: "agent",
    ...rest,
    ...fields,
  });
  declaringCatalog().agents.set(id, definition as Agent<Output.Output>);
  return definition;
}

export function workspace(spec: { readonly path: string }): WorkspaceInstance {
  if (!spec.path.trim()) {
    throw new Error("workspace(): a path is required");
  }
  const into = declaringCatalog();
  into.workspaces.add(spec.path);
  return workspaceInstance({
    id: into.claimId("workspace"),
    kind: "workspace",
    path: spec.path,
  });
}

export function sandbox(spec: SandboxSpec): SandboxInstance {
  if ("files" in spec && Object.keys(spec.files).length === 0) {
    throw new Error("sandbox({ files }): give it at least one file");
  }
  return sandboxInstance({
    id: declaringCatalog().claimId("sandbox"),
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
    id: declaringCatalog().claimId("artifact"),
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
  load(): SkillSet {
    return skillSet([{ kind: "load" }]);
  },
  none(): SkillSet {
    return skillSet([]);
  },
};

observable(agent, SESSIONS);
observable(artifact, ARTIFACTS);
observable(sandbox, SANDBOXES);
observable(workspace, WORKSPACES);
