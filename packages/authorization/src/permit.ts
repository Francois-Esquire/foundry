import type { AuthorizationReceipt } from "./schema";

const PERMIT_TOKEN = Symbol("foundry.authorization.permit");

export class Permit {
  readonly receipt: AuthorizationReceipt;
  readonly signal: AbortSignal;
  #released: boolean;
  readonly #cleanup: () => void;

  constructor(
    token: symbol,
    receipt: AuthorizationReceipt,
    signal: AbortSignal,
    cleanup: () => void
  ) {
    if (token !== PERMIT_TOKEN) {
      throw new TypeError(
        "Permit cannot be constructed directly; obtain one via Authorization.authorize()"
      );
    }
    this.receipt = receipt;
    this.signal = signal;
    this.#released = false;
    this.#cleanup = cleanup;
  }

  release(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    this.#cleanup();
  }
}

export function createPermit(
  receipt: AuthorizationReceipt,
  signal: AbortSignal,
  cleanup: () => void
): Permit {
  return new Permit(PERMIT_TOKEN, receipt, signal, cleanup);
}
