const EVENT_PREFIX = /^data: /;

/** Each server-sent event of one streamed response, parsed as JSON. */
export async function* serverSentEvents<T>(
  response: Response
): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) {
      return;
    }
    buffer += decoder.decode(read.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      yield JSON.parse(
        buffer.slice(0, boundary).replace(EVENT_PREFIX, "")
      ) as T;
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
}
