/**
 * The built-in exclusions, versioned so a later change to the set is an
 * observable input to reconciliation rather than a silent behavior drift.
 */
export const BASELINE_IGNORE_VERSION = 1;

export const BASELINE_IGNORE_PATTERNS: readonly string[] = [
  ".git/",
  ".foundry/",
  ".turbo/",
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
];

export const DIRECTORY_SOURCE = "host";
