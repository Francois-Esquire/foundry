/**
 * Credentials — runtime-only secrets vault, sibling primitive to `Config`.
 *
 * Intentionally *not* a contributed prefix. Persistence is a non-goal;
 * callers (desktop safeStorage, CLI env reader) own how secrets land
 * and how they're cleared. The class only owns:
 *
 *   - the in-memory snapshot,
 *   - shallow-merge mutation (`set` / `clear`),
 *   - a `"changed"` event for live consumers (`ModelManager`,
 *     `IntegrationManager`, …).
 *
 * **Open shape via declaration merging.** The default `CredentialsVault`
 * is empty; consuming packages widen it with their own credential
 * keys. Example:
 *
 * ```ts
 * declare module "@foundry/lib/config/credentials" {
 *   interface CredentialsVault {
 *     anthropicApiKey?: string | null;
 *     githubToken?: string | null;
 *   }
 * }
 * ```
 *
 * Setting a field to `null` clears it; `undefined` leaves it alone.
 */

import { EventEmitter } from "node:events";

import type { CredentialsChangePayload } from "./types";

/**
 * Open-by-design credentials vault. Empty in this package; consuming
 * packages widen via TypeScript declaration merging.
 */
// biome-ignore lint/suspicious/noEmptyInterface: Consumers extend this interface through declaration merging.
export interface CredentialsVault {}

export class Credentials extends EventEmitter {
  #vault: CredentialsVault;

  constructor(initial?: CredentialsVault) {
    super();
    this.#vault = { ...initial };
  }

  /** Current snapshot. */
  get(): Readonly<CredentialsVault> {
    return this.#vault;
  }

  /**
   * Shallow-merge patch into the vault. `null` values clear the key,
   * `undefined` leaves it alone. Emits `"changed"` on commit.
   */
  set(patch: Partial<CredentialsVault>): void {
    const before = this.#vault;
    const after: Record<string, unknown> = { ...before };
    const entries: [string, unknown][] = Object.entries(patch);
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      if (value === null) {
        Reflect.deleteProperty(after, key);
      } else {
        after[key] = value;
      }
    }
    const next = after as CredentialsVault;
    this.#vault = next;
    const payload: CredentialsChangePayload<CredentialsVault> = {
      after: next,
      before,
    };
    this.emit("changed", payload);
  }

  /** Wipe all keys. Emits `"changed"` once. */
  clear(): void {
    const before = this.#vault;
    const next: CredentialsVault = {};
    this.#vault = next;
    const payload: CredentialsChangePayload<CredentialsVault> = {
      after: next,
      before,
    };
    this.emit("changed", payload);
  }
}

export type CredentialsChange = CredentialsChangePayload<CredentialsVault>;
