import type { Catalog } from "~/lib/catalog";

/** Agent HTTP monitors can reuse origins explicitly selected by the workspace config. */
export function configuredMonitorUrl(catalog: Catalog): (url: URL) => boolean {
  return (url) =>
    [...catalog.monitors.values()].some(
      (spec) => spec.kind === "http" && new URL(spec.url).origin === url.origin
    );
}
