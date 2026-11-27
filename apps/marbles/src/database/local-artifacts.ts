import { join } from "node:path";

export function artifactBlobs(dir: string, scope: string): string {
  return join(dir, "workspaces", scope, "blobs");
}
