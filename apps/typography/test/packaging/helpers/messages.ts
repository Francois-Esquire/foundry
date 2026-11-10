import { expect } from "vitest";

const SENTENCE = /^[A-Z].*\.$/;
const SHOUTING_OR_DASHES = /[—!]/;

/** Messages a person reads: sentence case, a full stop, no em dashes, no exclamation marks. */
export const expectPlainSentences = (messages: readonly string[]) => {
  for (const message of messages) {
    expect(message).toMatch(SENTENCE);
    expect(message).not.toMatch(SHOUTING_OR_DASHES);
  }
};
