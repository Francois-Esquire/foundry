export interface PageInput<Cursor = string> {
  readonly cursor?: Cursor;
  readonly limit?: number;
}

export interface Page<T, Cursor = string> {
  readonly items: readonly T[];
  readonly nextCursor?: Cursor;
  readonly total?: number;
}
