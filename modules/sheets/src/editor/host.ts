import type { SaveAnswer, SavedBase, WatchEvent } from "../draft";

export interface OpenWorkbook {
  readonly base: SavedBase;
  readonly name: string;
  readonly text: string;
  readonly writable: boolean;
}

/** A lost watch is visible even when no workbook update can be delivered. */
export interface WatchUnavailable {
  readonly kind: "unavailable";
  readonly message: string;
  readonly terminal: boolean;
}

export type WorkbookWatchUpdate = WatchEvent | WatchUnavailable;

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
  ): AsyncIterable<WorkbookWatchUpdate>;
}
