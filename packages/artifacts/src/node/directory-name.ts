import type { ArtifactId } from "../ref";
import { artifactIdSchema } from "../ref";

const DOTS = /\./g;

export function directoryName(id: ArtifactId): string {
  return encodeURIComponent(id).replace(DOTS, "%2E");
}

export function artifactIdFromDirectory(name: string): ArtifactId | null {
  if (name.startsWith(".")) {
    return null;
  }
  const parsed = artifactIdSchema.safeParse(safeDecode(name));
  return parsed.success && directoryName(parsed.data) === name
    ? parsed.data
    : null;
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return "";
  }
}
