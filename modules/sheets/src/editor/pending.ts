import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorSession } from "./session";

/**
 * Something the user typed for one target on one sheet and has not applied
 * yet: contents for a cell, or a new name for the sheet itself.
 */
export interface Pending<Target extends { readonly sheet: string }> {
  /**
   * Set the first time a workbook without the target's sheet is shown.
   * A sheet that later takes the same name is a different sheet, so it
   * stays set: stranded text is kept to be copied, never applied, never
   * replaced, and only an explicit discard clears it.
   */
  readonly stranded: boolean;
  readonly target: Target;
  readonly text: string;
}

export interface PendingEdit<Target extends { readonly sheet: string }> {
  /**
   * For handlers that run before React re-renders, such as the blur that
   * follows Enter moving focus to the grid.
   */
  current(): Pending<Target> | null;
  /** The user's explicit choice to throw the text away, stranded or not. */
  discard(): void;
  /** Drops typing that was not stranded. */
  drop(): void;
  /** For rendering. */
  readonly pending: Pending<Target> | null;
  /** Records typing. Refused, returning false, while stranded text is kept. */
  type(target: Target, text: string): boolean;
}

/**
 * Holds one pending edit and watches every workbook the session shows, so
 * the edit is stranded even when its sheet is gone for only one save.
 * Every installed workbook is published synchronously, so none is missed.
 * Within a single save, a sheet replaced by another of the same name looks
 * unchanged: workbook files carry no sheet identities.
 */
export function usePending<Target extends { readonly sheet: string }>(
  session: EditorSession
): PendingEdit<Target> {
  const [pending, setPending] = useState<Pending<Target> | null>(null);
  // Widened so lint sees `current` as settable; handlers set it later.
  const now = useRef(null as Pending<Target> | null);
  const set = useCallback((next: Pending<Target> | null) => {
    now.current = next;
    setPending(next);
  }, []);

  useEffect(() => {
    const strand = () => {
      const entry = now.current;
      const sheets = session.getSnapshot().workbook?.sheets;
      if (
        entry &&
        !entry.stranded &&
        sheets &&
        !sheets.includes(entry.target.sheet)
      ) {
        set({ ...entry, stranded: true });
      }
    };
    strand();
    return session.subscribe(strand);
  }, [session, set]);

  const current = useCallback(() => now.current, []);
  const type = useCallback(
    (target: Target, text: string) => {
      if (now.current?.stranded) {
        return false;
      }
      set({ stranded: false, target, text });
      return true;
    },
    [set]
  );
  const drop = useCallback(() => {
    if (!now.current?.stranded) {
      set(null);
    }
  }, [set]);
  const discard = useCallback(() => set(null), [set]);
  return { current, discard, drop, pending, type };
}
