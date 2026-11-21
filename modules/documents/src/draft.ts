export interface SavedBase {
  readonly contentId: string;
  readonly digest: string;
}

export interface Draft {
  readonly base: SavedBase;
  readonly conflict: { readonly digest: string; readonly text: string } | null;
  readonly newer: SavedBase | null;
  readonly saved: string;
  readonly text: string;
}

export interface WatchEvent {
  readonly contentId: string | null;
  readonly entry: { readonly digest: string } | null;
  readonly gap?: boolean;
  readonly kind: "change" | "removed" | "snapshot";
}

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

export function dirty(draft: Draft): boolean {
  return draft.text !== draft.saved || draft.conflict !== null;
}

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

export function reloaded(
  draft: Draft,
  base: SavedBase,
  text: string,
  started: Draft = draft
): Draft {
  if (draft !== started) {
    return { ...draft, newer: base };
  }
  return opened(base, text);
}

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

export function takeTheirs(draft: Draft): Draft {
  if (!draft.conflict) {
    return draft;
  }
  return opened(
    { ...draft.base, digest: draft.conflict.digest },
    draft.conflict.text
  );
}
