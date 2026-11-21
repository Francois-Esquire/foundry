import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorSession } from "./session";

export interface Pending<Target extends { readonly sheet: string }> {
  readonly stranded: boolean;
  readonly target: Target;
  readonly text: string;
}

export interface PendingEdit<Target extends { readonly sheet: string }> {
  current(): Pending<Target> | null;
  discard(): void;
  drop(): void;
  readonly pending: Pending<Target> | null;
  renamed(entry: Pending<Target>, to: string): void;
  type(target: Target, text: string): boolean;
}

export function usePending<Target extends { readonly sheet: string }>(
  session: EditorSession
): PendingEdit<Target> {
  const [pending, setPending] = useState<Pending<Target> | null>(null);
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
  const renamed = useCallback(
    (entry: Pending<Target>, to: string) => {
      if (!entry.stranded && now.current?.target === entry.target) {
        set({ ...entry, target: { ...entry.target, sheet: to } });
      }
    },
    [set]
  );
  return { current, discard, drop, pending, renamed, type };
}
