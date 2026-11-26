import { expect, it } from "vitest";
import {
  containerSandboxConfigFromConstraints,
  containerSandboxConstraintsSchema,
} from "../container/constraints";
import { resolveContainerSpec } from "../container/sandbox";

it("normalizes exact destinations and defaults unspecified native egress to deny", async () => {
  const constraints = containerSandboxConstraintsSchema.parse({
    format: "foundry.sandbox.container/1",
    network: {
      destinations: [{ host: "API.OpenAI.com", ports: [443] }],
      mode: "allowlist",
    },
  });
  const config = containerSandboxConfigFromConstraints(constraints);
  expect((await resolveContainerSpec(config)).network).toEqual({
    destinations: [{ host: "api.openai.com", ports: [443] }],
    mode: "allowlist",
  });
  expect((await resolveContainerSpec({})).disableNetwork).toBe(true);
  expect(
    (await resolveContainerSpec({ network: "unrestricted" })).disableNetwork
  ).toBe(false);
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
    containerSandboxConstraintsSchema.safeParse({
      format: "foundry.sandbox.container/1",
      network: { destinations: [{ host }], mode: "allowlist" },
    }).success
  ).toBe(false);
});
