import { randomUUID } from "node:crypto";
import type { ModulePrincipal } from "@foundry/modules/gateway/types";

export const UNCLAIMED_BINDING_TTL_MS = 30 * 60 * 1000;

export interface EditorBinding {
  readonly artifactId: string;
  readonly contentId: string;
  readonly entry: string;
  readonly id: string;
  readonly installationId: string;
  readonly mode: "read" | "write";
  readonly moduleId: string;
  readonly release: string;
  readonly runtime: {
    readonly generation: number;
    readonly runtimeInstanceId: string;
  } | null;
  readonly signal: AbortSignal;
  readonly view: string | null;
}

export class EditorBindingDenied extends Error {
  override readonly name = "EditorBindingDenied";

  constructor() {
    super("This editor binding is not available to this app");
  }
}

type Stored = { -readonly [Key in keyof EditorBinding]: EditorBinding[Key] } & {
  readonly controller: AbortController;
  readonly openedAt: number;
};

export interface EditorBindingsOptions {
  readonly now?: () => number;
  readonly unclaimedTtlMs?: number;
}

export class EditorBindings {
  readonly #bindings = new Map<string, Stored>();
  readonly #now: () => number;
  readonly #ttl: number;

  constructor(options: EditorBindingsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttl = options.unclaimedTtlMs ?? UNCLAIMED_BINDING_TTL_MS;
  }

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

  current(binding: EditorBinding): boolean {
    const stored = this.#bindings.get(binding.id);
    return stored !== undefined && !stored.signal.aborted;
  }

  refresh(binding: EditorBinding, contentId: string): EditorBinding {
    const stored = this.#bindings.get(binding.id);
    if (!stored || stored.signal.aborted) {
      throw new EditorBindingDenied();
    }
    stored.contentId = contentId;
    return view(stored);
  }

  invalidate(installationId: string): void {
    for (const [id, binding] of this.#bindings) {
      if (binding.installationId === installationId) {
        binding.controller.abort();
        this.#bindings.delete(id);
      }
    }
  }

  stopped(installationId: string): void {
    for (const [id, binding] of this.#bindings) {
      if (binding.installationId === installationId && binding.runtime) {
        binding.controller.abort();
        this.#bindings.delete(id);
      }
    }
  }

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
