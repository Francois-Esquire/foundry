import type { SaveAnswer, SavedBase, WatchEvent } from "../draft";

export interface OpenWorkbook {
  readonly base: SavedBase;
  readonly name: string;
  readonly text: string;
  readonly writable: boolean;
}

/** Artifact operations in the editor's terms; transport details stay outside. */
export interface WorkbookHost {
  create(text: string, signal: AbortSignal): Promise<string>;
  read(binding: string, signal: AbortSignal): Promise<OpenWorkbook>;
  save(
    binding: string,
    digest: string,
    text: string,
    signal: AbortSignal
  ): Promise<SaveAnswer>;
  watch(
    binding: string,
    after: SavedBase,
    signal: AbortSignal
  ): AsyncIterable<WatchEvent>;
}
