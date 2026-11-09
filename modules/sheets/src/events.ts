const EVENT_PREFIX = /^data: /;

/**
 * Each server-sent event of one streamed response, parsed as JSON.
 *
 * However iteration ends (the stream ends, the caller returns early, an
 * event is not JSON, or `signal` aborts while waiting for the next chunk),
 * the response body is cancelled and its reader released, so the
 * connection closes and the server sees the client leave.
 */
export async function* serverSentEvents<T>(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  // A blocked read only returns once the reader is cancelled.
  const stop = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const read = await reader.read();
      if (read.done) {
        return;
      }
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const data = buffer.slice(0, boundary).replace(EVENT_PREFIX, "");
        buffer = buffer.slice(boundary + 2);
        yield JSON.parse(data) as T;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
