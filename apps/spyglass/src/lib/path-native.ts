// Native path operations for the portable analysis: `#path` (see `imports`
// in package.json) resolves here in every build, test and the CLI unless a
// browser build sets the `spyglass-browser` condition, which selects
// `path-posix.ts`. These are Node's own functions, platform semantics
// (Windows included) unchanged. The indirection exists because TypeScript
// does not resolve an `imports` target that names a builtin.
// biome-ignore lint/performance/noBarrelFile: a resolution target, not an aggregation of project modules.
export {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
