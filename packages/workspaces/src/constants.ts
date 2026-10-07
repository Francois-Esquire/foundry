/** The built-in exclusions every directory scan applies before `.gitignore`. */
export const BASELINE_IGNORE_PATTERNS: readonly string[] = [
  ".git/",
  ".foundry/",
  ".turbo/",
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
];

export const DIRECTORY_SOURCE = "host";
