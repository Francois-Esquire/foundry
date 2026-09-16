// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { generateReadableName } from "./readable-name";
export type { ResourceAddress } from "./resource-uri";
export {
  createResourceUrl,
  formatResourceUrl,
  parseResourcePath,
  parseResourceUrl,
  ResourceUriError,
} from "./resource-uri";
