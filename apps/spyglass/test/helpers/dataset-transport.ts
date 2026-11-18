import { vi } from "vitest";
import type { DatasetTransport } from "../../src/lib/dataset";

export function memoryTransport(
  files: Record<string, unknown>
): DatasetTransport {
  return (path) => Promise.resolve(files[path]);
}

export function recordReads(transport: DatasetTransport): {
  read: DatasetTransport;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    read: (path) => {
      reads.push(path);
      return transport(path);
    },
    reads,
  };
}

export function stubFetch(
  transport: DatasetTransport,
  { base = "http://localhost:4173/", status = 404 } = {}
) {
  const { href: mount } = new URL("./data/", base);
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const { href } = new URL(url, base);
    const value = href.startsWith(mount)
      ? await transport(href.slice(mount.length))
      : undefined;
    return value === undefined
      ? new Response(null, { status })
      : Response.json(value);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
