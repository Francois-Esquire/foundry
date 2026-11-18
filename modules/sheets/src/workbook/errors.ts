export type WorkbookErrorCode =
  | "contents-too-long"
  | "duplicate-sheet-name"
  | "invalid-address"
  | "invalid-file"
  | "invalid-sheet-name"
  | "last-sheet"
  | "newer-format"
  | "too-large"
  | "too-many-sheets"
  | "unknown-sheet";

export class WorkbookError extends Error {
  override readonly name = "WorkbookError";
  readonly code: WorkbookErrorCode;

  constructor(
    message: string,
    { code, ...options }: ErrorOptions & { readonly code: WorkbookErrorCode }
  ) {
    super(message, options);
    this.code = code;
  }
}
