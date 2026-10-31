import { isPortableRelativePath } from "@foundry/modules/manifest";
import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";

/**
 * Module source admission, shared by every path source enters through: the
 * renderer's save request, disk synchronization and agent proposals. Each
 * limit names its unit. These are the `authoring.source.*` settings' host
 * defaults and ceilings (spec §10); a Module's settings may lower them.
 */
export const SOURCE_LIMITS = {
  /** All files together, in UTF-8 bytes. */
  maxBytes: MODULE_SETTING_HOST_POLICY["authoring.source.maxBytes"].ceiling,
  /** One text file, in UTF-16 code units (a JavaScript string's length). */
  maxFileCodeUnits:
    MODULE_SETTING_HOST_POLICY["authoring.source.maxFileCodeUnits"].ceiling,
  maxFiles: MODULE_SETTING_HOST_POLICY["authoring.source.maxFiles"].ceiling,
  /** One path, in UTF-16 code units. */
  maxPathCharacters:
    MODULE_SETTING_HOST_POLICY["authoring.source.maxPathCharacters"].ceiling,
} as const;

export type SourceLimits = {
  readonly [Limit in keyof typeof SOURCE_LIMITS]: number;
};

export class SourceAdmissionError extends Error {
  override readonly name = "SourceAdmissionError";
}

const encoder = new TextEncoder();

/** Why `source` cannot be admitted, or `null` when it can. */
export function sourceAdmissionProblem(
  source: Readonly<Record<string, string>>,
  limits: SourceLimits = SOURCE_LIMITS
): string | null {
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

/** Throw a {@link SourceAdmissionError} unless `source` is admissible. */
export function admitSource(
  source: Readonly<Record<string, string>>,
  limits: SourceLimits = SOURCE_LIMITS
): void {
  const problem = sourceAdmissionProblem(source, limits);
  if (problem !== null) {
    throw new SourceAdmissionError(problem);
  }
}
