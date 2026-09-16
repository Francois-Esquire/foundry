import { createFalClient } from "@fal-ai/client";
import { modelErrors } from "../errors";
import type { FalEndpointClient } from "../fal/client";
import { getFalRuntime } from "../fal/client";
import type { LiveAccess } from "./types";

/**
 * How a `LiveAccess` becomes a client, for both transports. `credential` is the
 * configured-client holder, which is empty in any process that never called
 * `configure` — always the case in a browser build.
 *
 * `proxyUrl` carries `when: "always"` rather than a bare string. A string
 * normalizes to `{ url }` with no `when` (`config.js:59`) and
 * `shouldProxy(undefined)` returns `env.isBrowser` (`middleware.js:32`), so in
 * Node the middleware installs and then declines to act. `"always"` is true in
 * a browser too, so this widens the hosts served and changes nothing for a
 * renderer. On the socket path it is the token mint that must be intercepted —
 * `getTemporaryAuthToken` dispatches through `requestMiddleware` (`auth.js:24`);
 * on the WebRTC path it is the extensions' `context.run`/`context.fetch`.
 *
 * `credentials: ""` on every non-credential path: an omitted value falls back
 * to the client's own resolver, which reads `FAL_KEY` from the environment, and
 * no live entry may pick up an ambient key it was not handed.
 */
export function falClientFor(access: LiveAccess): FalEndpointClient {
  if (access.kind === "credential") {
    const runtime = getFalRuntime();
    if (runtime === null) {
      throw credentialUnavailable();
    }
    return runtime.client;
  }
  return createFalClient(
    access.kind === "proxy"
      ? { credentials: "", proxyUrl: { url: access.url, when: "always" } }
      : { credentials: "" }
  ) satisfies FalEndpointClient;
}

/**
 * Owned here so `openCore`'s precheck — which is what keeps a rejected `open`
 * from ever reaching a transport — and the transports themselves refuse
 * `credential` in one voice.
 */
export function credentialUnavailable(): Error {
  return modelErrors.LIVE_ACCESS_UNAVAILABLE({
    reason:
      "credential access needs the key-owning process; no configured client is present",
  });
}
