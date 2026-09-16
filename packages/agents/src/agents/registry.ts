import type { ToolLoopAgent } from "ai";

import type { LoopAgent } from "./loop-agent";
import type { AgentPreset } from "./resolve";

export type AgentEntry = ToolLoopAgent | LoopAgent;

/** Source-neutral catalog identity. `id` is deliberately opaque: built-ins,
 * file agents, and installed resources may choose their own namespace without
 * teaching this package how to parse it. */
export interface AgentPresetIdentity {
  readonly generation: number;
  readonly id: string;
}

export interface AgentPresetCatalogEntry extends AgentPresetIdentity {
  readonly preset: AgentPreset;
}

/** The named migration surface for consumers that still require a live
 * `ToolLoopAgent`/`LoopAgent`. Canonical catalogs derive this projection from
 * presets; Session meshes may use a mutable compatibility registry for their
 * already-live, Session-bound agents. */
export interface AgentCompatibilityProjection {
  get(id: string): AgentEntry | undefined;
  has(id: string): boolean;
  readonly kind: "agent-compatibility-projection";
  list(): string[];
}

export interface AgentCompatibilityRegistry
  extends AgentCompatibilityProjection {
  register(id: string, agent: AgentEntry): void;
  withdraw(id: string): boolean;
}

export interface AgentRegistry {
  readonly compatibility: AgentCompatibilityProjection;
  getPreset(id: string): AgentPresetCatalogEntry | undefined;
  readonly kind: "agent-preset-catalog";
  listPresets(): AgentPresetCatalogEntry[];
  registerPreset(entry: AgentPresetCatalogEntry): void;
  replacePreset(
    expected: AgentPresetIdentity,
    replacement: AgentPresetCatalogEntry
  ): void;
  withdrawPreset(expected: AgentPresetIdentity): boolean;
}

function assertIdentity(identity: AgentPresetIdentity): void {
  if (identity.id.trim() === "") {
    throw new Error("[agents] preset id must not be empty");
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) {
    throw new Error(
      `[agents] preset "${identity.id}" generation must be a non-negative safe integer`
    );
  }
}

function staleGenerationError(
  action: "replace" | "withdraw",
  expected: AgentPresetIdentity,
  actual: AgentPresetCatalogEntry
): Error {
  return new Error(
    `[agents] cannot ${action} preset "${expected.id}" at generation ${expected.generation}; current generation is ${actual.generation}`
  );
}

/**
 * A stable, generation-pinned raw projection. It resolves the retained preset
 * only on first invocation, so file-defined specs remain retained definitions
 * at load time rather than eagerly freezing a harness. Existing callers use
 * only invocation methods (`stream`/`generate`); other properties intentionally
 * remain outside this compatibility contract.
 */
function compatibilityEntry(entry: AgentPresetCatalogEntry): AgentEntry {
  let projected: Promise<AgentEntry> | undefined;
  const resolve = (): Promise<AgentEntry> => {
    projected ??= entry.preset.createAgent({}).then((harness) => harness.agent);
    return projected;
  };

  return new Proxy(Object.create(null) as object, {
    get(_target, property) {
      return (...args: unknown[]) =>
        resolve().then((agent) => {
          const member: unknown = Reflect.get(agent, property, agent);
          if (typeof member !== "function") {
            throw new Error(
              `[agents] compatibility projection for "${entry.id}" exposes invocation methods only`
            );
          }
          return Reflect.apply(member, agent, args) as unknown;
        });
    },
  }) as AgentEntry;
}

export function createAgentRegistry(): AgentRegistry {
  const presets = new Map<
    string,
    AgentPresetCatalogEntry & { readonly projected: AgentEntry }
  >();

  const compatibility: AgentCompatibilityProjection = Object.freeze({
    get(id: string) {
      return presets.get(id)?.projected;
    },
    has(id: string) {
      return presets.has(id);
    },
    kind: "agent-compatibility-projection",
    list() {
      return [...presets.keys()];
    },
  });

  return Object.freeze({
    compatibility,
    getPreset(id: string): AgentPresetCatalogEntry | undefined {
      const entry = presets.get(id);
      if (!entry) {
        return undefined;
      }
      return {
        generation: entry.generation,
        id: entry.id,
        preset: entry.preset,
      };
    },
    kind: "agent-preset-catalog",
    listPresets(): AgentPresetCatalogEntry[] {
      return [...presets.values()].map((entry) => ({
        generation: entry.generation,
        id: entry.id,
        preset: entry.preset,
      }));
    },
    registerPreset(entry: AgentPresetCatalogEntry): void {
      assertIdentity(entry);
      const existing = presets.get(entry.id);
      if (existing) {
        throw new Error(
          `[agents] preset "${entry.id}" is already registered at generation ${existing.generation}`
        );
      }
      const canonical = Object.freeze({
        generation: entry.generation,
        id: entry.id,
        preset: entry.preset,
        projected: compatibilityEntry(entry),
      });
      presets.set(entry.id, canonical);
    },
    replacePreset(
      expected: AgentPresetIdentity,
      replacement: AgentPresetCatalogEntry
    ): void {
      assertIdentity(expected);
      assertIdentity(replacement);
      if (replacement.id !== expected.id) {
        throw new Error(
          `[agents] replacement preset id "${replacement.id}" does not match "${expected.id}"`
        );
      }
      const existing = presets.get(expected.id);
      if (!existing) {
        throw new Error(
          `[agents] cannot replace unknown preset "${expected.id}"`
        );
      }
      if (existing.generation !== expected.generation) {
        throw staleGenerationError("replace", expected, existing);
      }
      if (replacement.generation <= expected.generation) {
        throw new Error(
          `[agents] replacement generation for "${expected.id}" must advance beyond ${expected.generation}`
        );
      }
      const canonical = Object.freeze({
        generation: replacement.generation,
        id: replacement.id,
        preset: replacement.preset,
        projected: compatibilityEntry(replacement),
      });
      presets.set(replacement.id, canonical);
    },
    withdrawPreset(expected: AgentPresetIdentity): boolean {
      assertIdentity(expected);
      const existing = presets.get(expected.id);
      if (!existing) {
        return false;
      }
      if (existing.generation !== expected.generation) {
        throw staleGenerationError("withdraw", expected, existing);
      }
      return presets.delete(expected.id);
    },
  });
}

/** Mutable raw registry for Session-bound live agents. The name makes the
 * compatibility status explicit; it is not a second preset catalog. */
export function createAgentCompatibilityRegistry(): AgentCompatibilityRegistry {
  const agents = new Map<string, AgentEntry>();
  return {
    get(id) {
      return agents.get(id);
    },
    has(id) {
      return agents.has(id);
    },
    kind: "agent-compatibility-projection",
    list() {
      return [...agents.keys()];
    },
    register(id, agent) {
      agents.set(id, agent);
    },
    withdraw(id) {
      return agents.delete(id);
    },
  };
}

export function resolveAgentEntry(
  id: string,
  projection: AgentCompatibilityProjection | undefined
): ToolLoopAgent {
  if (!projection) {
    throw new Error(
      `Cannot resolve agent "${id}" — no compatibility projection provided`
    );
  }
  if (
    (projection as { readonly kind?: unknown }).kind !==
    "agent-compatibility-projection"
  ) {
    throw new Error(
      `Cannot resolve agent "${id}" — raw access requires registry.compatibility`
    );
  }
  const agent = projection.get(id);
  if (!agent) {
    throw new Error(
      `Agent "${id}" not found in compatibility projection. Available: ${projection.list().join(", ") || "(none)"}`
    );
  }
  return agent;
}
