import { catalog } from "~/lib/catalog";

/** Agent HTTP monitors can reuse origins explicitly selected by the workspace config. */
export function configuredMonitorUrl(url: URL): boolean {
  return [...catalog.monitors.values()].some(
    (spec) => spec.kind === "http" && new URL(spec.url).origin === url.origin
  );
}
