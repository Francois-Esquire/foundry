export type SandboxErrorCode =
  | "cancelled"
  | "invalid-contract"
  | "invalid-transition"
  | "provider-failed";

export interface SandboxErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: SandboxErrorCode,
    message: string,
    options: SandboxErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "SandboxError";
    this.code = code;
    this.details = options.details;
  }

  toJSON(): {
    readonly name: string;
    readonly code: SandboxErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  } {
    return {
      code: this.code,
      message: this.message,
      name: this.name,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
