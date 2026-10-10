import { createHash } from "node:crypto";
import { canonicalizeJson } from "@foundry/lib/json";
import type { Output } from "ai";
import { catalog } from "~/authoring/catalog";
import {
  agentInstance,
  artifactInstance,
  sandboxInstance,
  workspaceInstance,
} from "~/lib/instances";
import type {
  Agent,
  AgentSettings,
  ArtifactInstance,
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
 * `const` the call is assigned to, else a digest of what the agent is (its
 * prompt and route). Workspaces, sandboxes and artifacts keep
 * registration-order ids: nothing durable is keyed by them.
 */

export function agent<OUTPUT extends Output.Output = never>(spec: {
  /** The agent's id; approvals and triggers it creates are kept under it. */
  readonly name?: string;
  readonly prompt: string;
  readonly model?: string;
  readonly provider?: string;
  /** Model settings and structured output every turn starts from. */
  readonly settings?: AgentSettings<OUTPUT>;
  readonly skills?: SkillSet;
}): Agent<OUTPUT> {
  const { name, ...rest } = spec;
  if (!rest.prompt.trim()) {
    throw new Error("agent(): a prompt is required");
  }
  if (name?.trim() === "") {
    throw new Error("agent(): a name cannot be blank");
  }
  const digest = createHash("sha256")
    .update(
      canonicalizeJson([rest.prompt, rest.provider ?? null, rest.model ?? null])
    )
    .digest("hex");
  const site = callSite();
  const id =
    name ??
    (site === undefined ? undefined : bindingAt(site)) ??
    `agent-${digest.slice(0, 16)}`;
  catalog.claimAgent(id, digest, site && originOf(site));
  return agentInstance<OUTPUT>({ id, kind: "agent", ...rest });
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
