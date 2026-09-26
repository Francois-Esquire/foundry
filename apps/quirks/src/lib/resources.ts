import { catalog } from "./catalog";
import type {
  AgentDefinition,
  ArtifactDefinition,
  SandboxDefinition,
  SandboxSpec,
  SkillOp,
  SkillSet,
  WorkspaceDefinition,
} from "./types";

/**
 * The definition words. Each is a preset with defaults; the context creates
 * the same things on the spot. Ids are registration-order placeholders
 * until the identity spike lands.
 */

export function agent(spec: {
  readonly prompt: string;
  readonly model?: string;
  readonly provider?: string;
  readonly skills?: SkillSet;
}): AgentDefinition {
  if (!spec.prompt.trim()) {
    throw new Error("agent(): a prompt is required");
  }
  return { id: catalog.claimId("agent"), kind: "agent", ...spec };
}

export function workspace(spec: {
  readonly path: string;
}): WorkspaceDefinition {
  if (!spec.path.trim()) {
    throw new Error("workspace(): a path is required");
  }
  return {
    id: catalog.claimId("workspace"),
    kind: "workspace",
    path: spec.path,
  };
}

export function sandbox(spec: SandboxSpec): SandboxDefinition {
  if ("files" in spec && Object.keys(spec.files).length === 0) {
    throw new Error("sandbox({ files }): give it at least one file");
  }
  return { id: catalog.claimId("sandbox"), kind: "sandbox", ...spec };
}

export function artifact(spec: {
  readonly name: string;
  readonly type: string;
}): ArtifactDefinition {
  if (!(spec.name.trim() && spec.type.trim())) {
    throw new Error("artifact(): a name and a type are required");
  }
  return { id: catalog.claimId("artifact"), kind: "artifact", ...spec };
}

function skillSet(ops: readonly SkillOp[]): SkillSet {
  return {
    add(glob) {
      if (!glob.trim()) {
        throw new Error("skills.add(): a glob is required");
      }
      return skillSet([...ops, { glob, kind: "add" }]);
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
};
