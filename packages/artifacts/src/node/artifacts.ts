import { createNodeAsyncScope } from "@foundry/lib/node/async-scope";
import { Artifacts, type ArtifactsOptions } from "../artifacts";

export function nodeArtifacts(
  options: Omit<ArtifactsOptions, "transactionScope"> = {}
): Artifacts {
  return new Artifacts({
    ...options,
    transactionScope: createNodeAsyncScope(),
  });
}
