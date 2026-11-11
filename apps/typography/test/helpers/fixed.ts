/**
 * The fixed values a test gives a function that takes its time and its ids:
 * one moment, and ids that count up so no two are alike.
 */
export const FIXED_TIME = "2026-11-10T09:00:00.000Z";

export const fixedClock = () => new Date(FIXED_TIME);

/** Ids that count up from `<prefix>-1`, so a test can name the ones it expects. */
export const countingIds = (prefix = "id") => {
  let issued = 0;
  return () => {
    issued += 1;
    return `${prefix}-${issued}`;
  };
};

const made = countingIds("made");

/**
 * What a test gives a run it starts itself: the fixed clock, and ids that
 * no two runs in the file share.
 */
export const fixedRun = { clock: fixedClock, newId: made } as const;

/** What a test gives a revision it makes itself: the fixed time and an id of its own. */
export const stamp = () => ({ at: FIXED_TIME, id: made() });
