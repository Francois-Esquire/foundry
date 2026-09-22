const BYTE_RANGE = /^bytes=(\d+)-(\d*)$/;

import { isStoragePath } from "@foundry/core/storage";

import type { Artifacts, Content } from "./substrate";

export async function fileResponse(
  artifacts: Pick<Artifacts, "readFileRange">,
  content: Content,
  path: string,
  options: {
    readonly range?: string | null;
    readonly headers?: ConstructorParameters<typeof Headers>[0];
  } = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  const entry = isStoragePath(path) ? content.tree[path] : undefined;
  if (entry?.type !== "file") {
    return new Response(null, { headers, status: 404 });
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", entry.mime ?? "application/octet-stream");
  }
  headers.set("Accept-Ranges", "bytes");
  const plan = parseRange(options.range ?? null, entry.bytes);
  if (plan.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${entry.bytes}`);
    headers.set("Content-Length", "0");
    return new Response(null, { headers, status: 416 });
  }
  const file = await artifacts.readFileRange(content.id, path, {
    start: plan.start,
    ...(plan.end === undefined ? {} : { end: plan.end }),
  });
  if (!file) {
    return new Response(null, { headers, status: 404 });
  }
  if (plan.kind === "partial") {
    headers.set(
      "Content-Range",
      `bytes ${file.range.start}-${file.range.end - 1}/${entry.bytes}`
    );
    headers.set("Content-Length", String(file.range.end - file.range.start));
  } else {
    headers.set("Content-Length", String(entry.bytes));
  }
  return new Response(streamOf(file.body), {
    headers,
    status: plan.kind === "partial" ? 206 : 200,
  });
}

function streamOf(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        await iterator.return?.(reason);
      },
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      },
    },
    // Aborted seeks must not fetch chunks ahead of the consumer.
    { highWaterMark: 0 }
  );
}

type RangePlan =
  | { readonly kind: "whole"; readonly start: number; readonly end: undefined }
  | { readonly kind: "unsatisfiable" }
  | {
      readonly kind: "partial";
      readonly start: number;
      readonly end: number | undefined;
    };

function parseRange(header: string | null, byteLength: number): RangePlan {
  const whole = { end: undefined, kind: "whole", start: 0 } as const;
  if (header === null) {
    return whole;
  }
  const match = BYTE_RANGE.exec(header.trim());
  if (!match) {
    return whole;
  }
  const start = Number(match[1]);
  const endInclusive = match[2] === "" ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start)) {
    return whole;
  }
  if (
    endInclusive !== undefined &&
    (!Number.isSafeInteger(endInclusive) || endInclusive < start)
  ) {
    return whole;
  }
  if (start >= byteLength) {
    return { kind: "unsatisfiable" };
  }
  return {
    end:
      endInclusive === undefined
        ? undefined
        : Math.min(endInclusive + 1, byteLength),
    kind: "partial",
    start,
  };
}
