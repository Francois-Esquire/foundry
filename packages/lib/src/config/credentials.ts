import { TypedEmitter } from "../emitter";
import type { CredentialsChangePayload } from "./types";

// biome-ignore lint/suspicious/noEmptyInterface: Consumers extend this interface through declaration merging.
export interface CredentialsVault {}

export interface CredentialsEventMap {
  changed: [payload: CredentialsChangePayload<CredentialsVault>];
  // biome-ignore lint/suspicious/noExplicitAny: Preserve EventEmitter compatibility for custom event names.
  [key: string]: any[];
}

export class Credentials extends TypedEmitter<CredentialsEventMap> {
  #vault: CredentialsVault;

  constructor(initial?: CredentialsVault) {
    super();
    this.#vault = { ...initial };
  }

  get(): Readonly<CredentialsVault> {
    return this.#vault;
  }

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
