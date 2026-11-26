import { isPortableRelativePath } from "./manifest";
import { MODULE_SETTING_HOST_POLICY } from "./settings";

export const MODULE_SOURCE_LIMITS = Object.freeze({
  maxBytes: MODULE_SETTING_HOST_POLICY["authoring.source.maxBytes"].ceiling,
  maxFileCodeUnits:
    MODULE_SETTING_HOST_POLICY["authoring.source.maxFileCodeUnits"].ceiling,
  maxFiles: MODULE_SETTING_HOST_POLICY["authoring.source.maxFiles"].ceiling,
  maxPathCharacters:
    MODULE_SETTING_HOST_POLICY["authoring.source.maxPathCharacters"].ceiling,
} as const);

export type ModuleSourceLimits = {
  readonly [Limit in keyof typeof MODULE_SOURCE_LIMITS]: number;
};

export class ModuleSourceAdmissionError extends Error {
  override readonly name = "ModuleSourceAdmissionError";
}

const encoder = new TextEncoder();

export function moduleSourceAdmissionProblem(
  source: Readonly<Record<string, string>>,
  effective: ModuleSourceLimits = MODULE_SOURCE_LIMITS
): string | null {
  const limits = withinCeilings(effective);
  const entries = Object.entries(source);
  if (entries.length > limits.maxFiles) {
    return `Source has ${entries.length} files; the limit is ${limits.maxFiles}.`;
  }
  let bytes = 0;
  for (const [path, text] of entries) {
    if (path.length > limits.maxPathCharacters) {
      return `A source path is longer than ${limits.maxPathCharacters} characters.`;
    }
    if (!isPortableRelativePath(path)) {
      return `Source path is not a portable relative path: ${path}`;
    }
    if (text.length > limits.maxFileCodeUnits) {
      return `${path} is longer than ${limits.maxFileCodeUnits} UTF-16 code units.`;
    }
    bytes += encoder.encode(text).byteLength;
    if (bytes > limits.maxBytes) {
      return `Source is larger than ${limits.maxBytes} UTF-8 bytes.`;
    }
  }
  return null;
}

function withinCeilings(limits: ModuleSourceLimits): ModuleSourceLimits {
  return {
    maxBytes: Math.min(limits.maxBytes, MODULE_SOURCE_LIMITS.maxBytes),
    maxFileCodeUnits: Math.min(
      limits.maxFileCodeUnits,
      MODULE_SOURCE_LIMITS.maxFileCodeUnits
    ),
    maxFiles: Math.min(limits.maxFiles, MODULE_SOURCE_LIMITS.maxFiles),
    maxPathCharacters: Math.min(
      limits.maxPathCharacters,
      MODULE_SOURCE_LIMITS.maxPathCharacters
    ),
  };
}

export function admitModuleSource(
  source: Readonly<Record<string, string>>,
  limits: ModuleSourceLimits = MODULE_SOURCE_LIMITS
): void {
  const problem = moduleSourceAdmissionProblem(source, limits);
  if (problem !== null) {
    throw new ModuleSourceAdmissionError(problem);
  }
}
