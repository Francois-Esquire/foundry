/** Notices are short messages for the person using the studio, shown until dismissed. */

export type NoticeTone = "info" | "error";

export interface Notice {
  readonly id: string;
  readonly message: string;
  readonly tone: NoticeTone;
}

/** What a use case hands back: its value, or the notice that says why it failed. */
export type Outcome<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly notice: Notice };

/**
 * Adds a notice, unless one with the same message is already showing. Returns
 * the notice that now carries the message.
 */
export const withNotice = (
  notices: readonly Notice[],
  notice: Notice
): { readonly notices: readonly Notice[]; readonly notice: Notice } => {
  const showing = notices.find(
    (existing) =>
      existing.message === notice.message && existing.tone === notice.tone
  );
  return showing
    ? { notice: showing, notices }
    : { notice, notices: [...notices, notice] };
};

export const withoutNotice = (notices: readonly Notice[], id: string) =>
  notices.some((notice) => notice.id === id)
    ? notices.filter((notice) => notice.id !== id)
    : notices;
