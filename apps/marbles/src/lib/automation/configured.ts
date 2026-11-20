import type { Registry } from "~/lib/registry";

export function configuredMonitorUrl(
  registry: Registry
): (url: URL) => boolean {
  return (url) =>
    [...registry.monitors.values()].some(
      ({ source }) =>
        source.kind === "http" && new URL(source.url).origin === url.origin
    );
}
