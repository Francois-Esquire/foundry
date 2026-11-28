import { expect, it } from "vitest";
import { containerSpecSchema, resolveContainerSpec } from "../containers/spec";

it("normalizes exact destinations and defaults unspecified egress to none", () => {
  const input = containerSpecSchema.parse({
    network: {
      destinations: [{ host: "API.OpenAI.com", ports: [443] }],
      mode: "allowlist",
    },
  });
  expect(
    resolveContainerSpec({ input, labels: {}, name: "c1" }).network
  ).toEqual({
    destinations: [{ host: "api.openai.com", ports: [443] }],
    mode: "allowlist",
  });
  expect(
    resolveContainerSpec({ input: {}, labels: {}, name: "c2" }).network
  ).toBe("none");
  expect(
    resolveContainerSpec({
      input: { network: "internet" },
      labels: {},
      name: "c3",
    }).network
  ).toBe("internet");
  expect(
    resolveContainerSpec({
      input: { network: "open" },
      labels: {},
      name: "c4",
    }).network
  ).toBe("open");
});

it.each([
  "https://api.openai.com",
  "*.openai.com",
  "api.openai.com:443",
  "127.0.0.1",
  "api.openai.com/",
  "api.openai.com\u0000",
])("rejects a non-exact hostname %s", (host) => {
  expect(
    containerSpecSchema.safeParse({
      network: { destinations: [{ host }], mode: "allowlist" },
    }).success
  ).toBe(false);
});
