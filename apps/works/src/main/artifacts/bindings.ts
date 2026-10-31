import { randomUUID } from "node:crypto";
import type { ModulePrincipal } from "@foundry/modules/gateway/types";

/**
 * How long a binding nobody has resolved stays usable: long enough for an
 * editor Module to start cold, including a wait for sandbox capacity. A
 * recommended starting value (spec §10 style), not an acceptance threshold.
 */
export const UNCLAIMED_BINDING_TTL_MS = 30 * 60 * 1000;

/** One opened entry, as the host pinned it. */
export interface EditorBinding {
  readonly artifactId: string;
  /** The Content it reads and saves; refreshing moves it to the active one. */
  readonly contentId: string;
  readonly entry: string;
  /** Opaque and unguessable; it confers nothing outside its owning runtime. */
  readonly id: string;
  readonly installationId: string;
  readonly mode: "read" | "write";
  readonly moduleId: string;
  /** The Module release the editor runs: a runtime of another Version cannot use it. */
  readonly release: string;
  /** Pinned by the first runtime that resolves it, which then owns it. */
  readonly runtime: {
    readonly generation: number;
    readonly runtimeInstanceId: string;
  } | null;
  /** Aborts when the binding is invalidated. */
  readonly signal: AbortSignal;
  /** The editor View it was opened for; null for one a Program created. */
  readonly view: string | null;
}

/** A binding that is unknown, invalidated, or owned by another runtime. */
export class EditorBindingDenied extends Error {
  override readonly name = "EditorBindingDenied";

  constructor() {
    super("This editor binding is not available to this app");
  }
}

type Stored = { -readonly [Key in keyof EditorBinding]: EditorBinding[Key] } & {
  readonly controller: AbortController;
  /** When it was minted; an unclaimed binding expires from here. */
  readonly openedAt: number;
};

export interface EditorBindingsOptions {
  /** The clock; tests move it. */
  readonly now?: () => number;
  /** How long an unclaimed binding lasts; {@link UNCLAIMED_BINDING_TTL_MS} by default. */
  readonly unclaimedTtlMs?: number;
}

/**
 * Editor bindings (spec §5): host-owned, pinning Artifact, Content, entry,
 * access mode and runtime identity. A runtime may own several. A Program
 * stop or Version selection leaves its bindings unusable (a new runtime has
 * another identity, a new Version another release); revoking a binding
 * Capability invalidates the Installation's bindings.
 *
 * They live in memory only: a binding names a runtime of this process, and
 * no runtime outlives it, so a restart has nothing to resume — reopening
 * the file mints a new one. A binding no runtime claims (the editor never
 * opened, or its window closed first) expires after `unclaimedTtlMs`; a
 * claimed one lasts as long as its runtime's identity is current.
 */
export class EditorBindings {
  readonly #bindings = new Map<string, Stored>();
  readonly #now: () => number;
  readonly #ttl: number;

  constructor(options: EditorBindingsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttl = options.unclaimedTtlMs ?? UNCLAIMED_BINDING_TTL_MS;
  }

  /**
   * Mint a binding for an Installation's editor. With `owner`, the binding
   * is pinned to that runtime at once (a binding a Program created itself).
   */
  open(
    input: Omit<EditorBinding, "id" | "runtime" | "signal">,
    owner?: ModulePrincipal
  ): EditorBinding {
    this.#expire();
    const controller = new AbortController();
    const binding: Stored = {
      ...input,
      controller,
      id: randomUUID(),
      openedAt: this.#now(),
      runtime: owner ? runtimeOf(owner) : null,
      signal: controller.signal,
    };
    this.#bindings.set(binding.id, binding);
    return view(binding);
  }

  /**
   * The binding, for the runtime asking. The first runtime of the binding's
   * Installation and release to resolve it owns it from then on; anything
   * else is refused.
   */
  resolve(principal: ModulePrincipal, id: string): EditorBinding {
    this.#expire();
    const binding = this.#bindings.get(id);
    if (
      !binding ||
      binding.signal.aborted ||
      binding.installationId !== principal.installationId ||
      binding.release !== principal.contentId
    ) {
      throw new EditorBindingDenied();
    }
    if (!binding.runtime) {
      binding.runtime = runtimeOf(principal);
    } else if (
      binding.runtime.runtimeInstanceId !== principal.runtimeInstanceId ||
      binding.runtime.generation !== principal.generation
    ) {
      throw new EditorBindingDenied();
    }
    return view(binding);
  }

  /** Whether the binding is still the one its holder resolved. */
  current(binding: EditorBinding): boolean {
    const stored = this.#bindings.get(binding.id);
    return stored !== undefined && !stored.signal.aborted;
  }

  /** Move a binding to newer Content of its Artifact, through the host. */
  refresh(binding: EditorBinding, contentId: string): EditorBinding {
    const stored = this.#bindings.get(binding.id);
    if (!stored || stored.signal.aborted) {
      throw new EditorBindingDenied();
    }
    stored.contentId = contentId;
    return view(stored);
  }

  /** Invalidate every binding of an Installation, ending their streams. */
  invalidate(installationId: string): void {
    for (const [id, binding] of this.#bindings) {
      if (binding.installationId === installationId) {
        binding.controller.abort();
        this.#bindings.delete(id);
      }
    }
  }

  /** Drop the bindings no runtime claimed in time. */
  #expire(): void {
    const cutoff = this.#now() - this.#ttl;
    for (const [id, binding] of this.#bindings) {
      if (!binding.runtime && binding.openedAt <= cutoff) {
        binding.controller.abort();
        this.#bindings.delete(id);
      }
    }
  }
}

function runtimeOf(principal: ModulePrincipal) {
  return {
    generation: principal.generation,
    runtimeInstanceId: principal.runtimeInstanceId,
  };
}

function view(binding: Stored): EditorBinding {
  const { controller: _controller, openedAt: _openedAt, ...rest } = binding;
  return { ...rest };
}
