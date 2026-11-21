const EVENT_PREFIX = /^data: /;

export async function* serverSentEvents<T>(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
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
