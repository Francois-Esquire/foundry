import posix from "path-browserify";

// POSIX path operations for browser builds of the portable analysis.
//
// The computation modules import `#path` (see `imports` in package.json).
// It resolves here only under the `spyglass-browser` condition, which a
// browser build sets explicitly. Every other build, test and the CLI resolve
// it to `path-native.ts`, Node's own functions, so native analysis keeps
// Node's semantics, Windows included. A browser build without the condition
// gets `node:path`, which has no browser implementation.
//
// path-browserify is Node's POSIX path module, published separately. Its
// `resolve` falls back to `process.cwd()` when no segment is absolute; a
// browser has no `process`, so such a call throws rather than guessing a
// directory. The analysis passes absolute roots. Snapshots keep native
// absolute paths, so a snapshot captured on Windows is not replayable
// through these operations.
export const {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} = posix;
