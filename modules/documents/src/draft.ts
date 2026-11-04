/**
 * The editor's Draft against the saved entry. Saved state only changes
 * through the host: a save answer, a watch event or an explicit reload. An
 * update never replaces unsaved edits; it is surfaced as a newer saved base
 * and the Draft stays until the user resolves it.
 */

/** The saved entry the Draft was last based on: its Content and digest. */
export interface SavedBase {
  readonly contentId: string;
  readonly digest: string;
}

export interface Draft {
  readonly base: SavedBase;
  /** A save that lost to another writer: the text saved there instead. */
  readonly conflict: { readonly digest: string; readonly text: string } | null;
  /** A newer saved version seen while the Draft had unsaved edits. */
  readonly newer: SavedBase | null;
  /** The text of `base`. */
  readonly saved: string;
  /** What the editor shows. */
  readonly text: string;
}

/** What the watch reports about the bound entry. */
export interface WatchEvent {
  readonly contentId: string | null;
  readonly entry: { readonly digest: string } | null;
  readonly gap?: boolean;
  readonly kind: "change" | "removed" | "snapshot";
}

/** A save's answer, as the host returns it. */
export type SaveAnswer =
  | { readonly digest: string; readonly kind: "saved" }
  | {
      readonly current: { readonly digest: string; readonly text: string };
      readonly kind: "conflict";
    }
  | { readonly kind: string; readonly reason?: string };

export function opened(base: SavedBase, text: string): Draft {
  return { base, conflict: null, newer: null, saved: text, text };
}

export function edit(draft: Draft, text: string): Draft {
  return { ...draft, text };
}

/** Unsaved edits, or an unresolved conflict. */
export function dirty(draft: Draft): boolean {
  return draft.text !== draft.saved || draft.conflict !== null;
}

/**
 * What a watch event means for the Draft. `reload` asks the editor to read
 * the newer saved text (the Draft is clean, so nothing is lost). With
 * unsaved edits the newer base is only surfaced.
 */
export function observed(
  draft: Draft,
  event: WatchEvent
): {
  readonly draft: Draft;
  readonly reload: SavedBase | null;
  readonly removed: boolean;
} {
  if (event.kind === "removed" || !(event.entry && event.contentId)) {
    return { draft, reload: null, removed: true };
  }
  const seen = { contentId: event.contentId, digest: event.entry.digest };
  if (
    seen.digest === draft.base.digest &&
    seen.contentId === draft.base.contentId
  ) {
    return { draft: { ...draft, newer: null }, reload: null, removed: false };
  }
  if (dirty(draft)) {
    return { draft: { ...draft, newer: seen }, reload: null, removed: false };
  }
  return { draft, reload: seen, removed: false };
}

/** The newer saved text read after `observed` asked for it (or the user chose it). */
export function reloaded(_draft: Draft, base: SavedBase, text: string): Draft {
  return opened(base, text);
}

/**
 * Apply a save's answer for the text that was sent. Edits typed while the
 * save was in flight stay in the Draft on the new base.
 */
export function answered(
  draft: Draft,
  sent: string,
  answer: SaveAnswer
): Draft {
  if (answer.kind === "saved" && "digest" in answer) {
    return {
      ...draft,
      base: { ...draft.base, digest: answer.digest },
      conflict: null,
      newer: null,
      saved: sent,
    };
  }
  if (answer.kind === "conflict" && "current" in answer) {
    return { ...draft, conflict: answer.current };
  }
  return draft;
}

/**
 * Resolve a conflict by keeping the Draft: it is now based on the saved
 * version, so the next save deliberately replaces it.
 */
export function keepMine(draft: Draft): Draft {
  if (!draft.conflict) {
    return draft;
  }
  return {
    ...draft,
    base: { ...draft.base, digest: draft.conflict.digest },
    conflict: null,
    newer: null,
    saved: draft.conflict.text,
  };
}

/** Resolve a conflict by taking the saved version, dropping the Draft's edits. */
export function takeTheirs(draft: Draft): Draft {
  if (!draft.conflict) {
    return draft;
  }
  return opened(
    { ...draft.base, digest: draft.conflict.digest },
    draft.conflict.text
  );
}
