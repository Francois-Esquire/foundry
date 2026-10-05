import type { Registry } from "~/lib/registry";

/** Agent HTTP monitors can reuse origins explicitly selected by the workspace config. */
export function configuredMonitorUrl(
  registry: Registry
): (url: URL) => boolean {
  return (url) =>
    [...registry.monitors.values()].some(
      ({ source }) =>
        source.kind === "http" && new URL(source.url).origin === url.origin
    );
}
