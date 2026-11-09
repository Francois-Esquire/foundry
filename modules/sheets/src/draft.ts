/**
 * The editor's Draft against the saved entry. Saved state only changes
 * through the host: a save answer, a watch event or an explicit reload. An
 * update never replaces unsaved edits; it is surfaced as a newer saved base
 * and the Draft stays until the user resolves it.
 *
 * Its text is the workbook file. A Workbook always saves the same file for
 * the same contents, so comparing texts tells whether there are edits.
 * Started as a copy of the Documents Module's Draft; neither Module
 * depends on the other.
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
  /**
   * The latest saved version the watch reported that is not `base`. The
   * watch reports versions in the order they were saved, so this is the
   * newest one known.
   */
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
  if (sameBase(seen, draft.base)) {
    return { draft: { ...draft, newer: null }, reload: null, removed: false };
  }
  if (dirty(draft)) {
    return { draft: { ...draft, newer: seen }, reload: null, removed: false };
  }
  return { draft, reload: seen, removed: false };
}

/**
 * Apply a save's answer for the text that was sent. Edits typed while the
 * save was in flight stay in the Draft on the new base.
 *
 * A saved answer only says the entry was at the old base when this save
 * landed. The watch may already have reported another writer's save after
 * it, so a newer version the watch reported stays unless it is this save.
 * The editor reloads it once the Draft is clean.
 */
export function answered(
  draft: Draft,
  sent: string,
  answer: SaveAnswer
): Draft {
  if (answer.kind === "saved" && "digest" in answer) {
    const base = { ...draft.base, digest: answer.digest };
    return {
      ...draft,
      base,
      conflict: null,
      newer: newerThan(draft.newer, base),
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
  const base = { ...draft.base, digest: draft.conflict.digest };
  return {
    ...draft,
    base,
    conflict: null,
    newer: newerThan(draft.newer, base),
    saved: draft.conflict.text,
  };
}

/** Resolve a conflict by taking the saved version, dropping the Draft's edits. */
export function takeTheirs(draft: Draft): Draft {
  if (!draft.conflict) {
    return draft;
  }
  const base = { ...draft.base, digest: draft.conflict.digest };
  return {
    ...opened(base, draft.conflict.text),
    newer: newerThan(draft.newer, base),
  };
}

/** A reported newer version, unless it is the base itself. */
function newerThan(newer: SavedBase | null, base: SavedBase): SavedBase | null {
  return newer && !sameBase(newer, base) ? newer : null;
}

export function sameBase(left: SavedBase, right: SavedBase): boolean {
  return left.contentId === right.contentId && left.digest === right.digest;
}
