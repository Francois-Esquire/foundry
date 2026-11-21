import { expect, it, vi } from "vitest";
import { serverSentEvents } from "../events";

it.each(["return", "invalid"])("releases a watch on %s", async (mode) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel,
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${mode === "invalid" ? "invalid" : "{}"}\n\n`
        )
      );
    },
  });
  const events = serverSentEvents(new Response(body));
  if (mode === "invalid") {
    await expect(events.next()).rejects.toThrow(SyntaxError);
  } else {
    await events.next();
    await events.return(undefined);
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
