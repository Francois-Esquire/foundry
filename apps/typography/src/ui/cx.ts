/** Joins class names, dropping the ones a condition switched off. */
export const cx = (...names: readonly (string | false | undefined)[]) =>
  names.filter(Boolean).join(" ");
