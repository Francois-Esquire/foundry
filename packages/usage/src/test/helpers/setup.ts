/** A test setup file: see the vitest configuration. */
import { holdModelsDev } from "@foundry/models/catalog/models-dev-source";
import { vi } from "vitest";

/** The models.dev entries these tests price, trimmed from `https://models.dev/catalog.json`. */
const PAYLOAD = {
  models: {
    "anthropic/claude-sonnet-4-5": { name: "Claude Sonnet 4.5" },
    "openai/gpt-5.5": { name: "GPT-5.5" },
  },
  providers: {
    anthropic: {
      models: {
        "claude-sonnet-4-5": {
          cost: { cache_read: 0.3, cache_write: 3.75, input: 3, output: 15 },
        },
      },
    },
    openai: {
      models: {
        "gpt-5.5": {
          cost: {
            cache_read: 0.5,
            input: 5,
            output: 30,
            tiers: [
              {
                cache_read: 1,
                input: 10,
                output: 45,
                tier: { size: 272_000, type: "context" },
              },
            ],
          },
        },
      },
    },
  },
};

/**
 * Every test file starts with this: models.dev answers with {@link PAYLOAD},
 * and any other request is refused, so no test reaches the network. The
 * prices are then loaded, as a host would load them, before any test runs.
 */
vi.stubGlobal(
  "fetch",
  vi.fn((url: string | URL) =>
    String(url) === "https://models.dev/catalog.json"
      ? Promise.resolve(Response.json(PAYLOAD))
      : Promise.reject(new Error(`unexpected fetch of ${String(url)}`))
  )
);

await holdModelsDev().loaded;
