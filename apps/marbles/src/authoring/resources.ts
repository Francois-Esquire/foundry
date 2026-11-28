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
import { trackCreatedDeclaration } from "~/authoring/runtime";
import type {
  Agent,
  ArtifactInstance,
  DeferredAgent,
  SandboxInstance,
  SandboxSpec,
  SkillOp,
  SkillSet,
  WorkspaceInstance,
} from "~/lib/definitions/types";
import {
  ARTIFACTS,
  observable,
  SANDBOXES,
  SESSIONS,
  WORKSPACES,
} from "~/lib/events/source";
import { sha256HexSync } from "~/lib/shared/hash";
import { jsonData } from "~/lib/shared/json-data";

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
  const digest = sha256HexSync(
    canonicalizeJson(["function", define.toString()])
  );
  const id = name ?? `agent-${digest.slice(0, 16)}`;
  const created = recipeInstance<OUTPUT, INPUT>(
    {
      define: define as unknown as DefineAgent<Output.Output, unknown>,
      id,
      route: {},
      settings: [],
    },
    { define, digest, explicit: name !== undefined }
  );
  trackCreatedDeclaration(created);
  return created;
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
  const digest = sha256HexSync(
    canonicalizeJson(
      typeof prompt === "string" ? [prompt] : ["portable", prompt.key]
    )
  );
  const id = name ?? `agent-${digest.slice(0, 16)}`;
  const created = agentInstance<OUTPUT>(
    {
      id,
      kind: "agent",
      ...rest,
      ...fields,
    },
    { digest, explicit: name !== undefined }
  );
  trackCreatedDeclaration(created);
  return created;
}

export function workspace(spec: { readonly path: string }): WorkspaceInstance {
  if (!spec.path.trim()) {
    throw new Error("workspace(): a path is required");
  }
  const id = `workspace#${sha256HexSync(canonicalizeJson({ path: spec.path })).slice(0, 16)}`;
  return workspaceInstance({
    id,
    kind: "workspace",
    path: spec.path,
  });
}

export function sandbox(spec: SandboxSpec): SandboxInstance {
  if ("files" in spec && Object.keys(spec.files).length === 0) {
    throw new Error("sandbox({ files }): give it at least one file");
  }
  const id = `sandbox#${sha256HexSync(canonicalizeJson(jsonData(spec))).slice(0, 16)}`;
  return sandboxInstance({
    id,
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
  const id = `artifact#${sha256HexSync(canonicalizeJson({ name: spec.name, type: spec.type })).slice(0, 16)}`;
  return artifactInstance({
    id,
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
