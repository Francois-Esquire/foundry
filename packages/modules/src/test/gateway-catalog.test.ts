import { describe, expect, it } from "vitest";
import {
  createModuleCapabilityCatalog,
  ModuleGatewayContractError,
} from "../gateway/catalog";
import type {
  ModuleCapabilitySchema,
  ModuleUnaryCapabilityRegistration,
} from "../gateway/types";
import { PORTABLE_SCHEMA_DIALECT } from "../manifest";

const emptySchema = Object.freeze({
  $schema: PORTABLE_SCHEMA_DIALECT,
  type: "object",
} as const);
const schema: ModuleCapabilitySchema<unknown> = {
  description: emptySchema,
  parse: (input) => input,
};

function registration(
  capability = "platform.notifications"
): ModuleUnaryCapabilityRegistration<unknown, unknown> {
  return {
    descriptor: {
      capability,
      documentation: "Send an approved notification",
      input: emptySchema,
      output: emptySchema,
      version: 1,
    },
    input: schema,
    invoke: (input) => Promise.resolve(input),
    mode: "unary",
    output: schema,
  };
}

describe("Module Gateway public contracts", () => {
  it("projects one immutable catalog from provider registrations", () => {
    const typedRegistration: ModuleUnaryCapabilityRegistration<
      { readonly title: string },
      { readonly delivered: boolean }
    > = {
      descriptor: registration().descriptor,
      input: {
        description: emptySchema,
        parse: (input) => ({ title: String(input) }),
      },
      invoke: (input) => Promise.resolve({ delivered: input.title.length > 0 }),
      mode: "unary",
      output: {
        description: emptySchema,
        parse: (input) => ({ delivered: Boolean(input) }),
      },
    };
    const catalog = createModuleCapabilityCatalog({
      generation: 3,
      registrations: [typedRegistration],
    });

    expect(catalog).toEqual({
      capabilities: [{ ...registration().descriptor, mode: "unary" }],
      generation: 3,
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.capabilities)).toBe(true);
  });

  it("rejects unnamespaced and duplicate capability identities", () => {
    expect(() =>
      createModuleCapabilityCatalog({
        generation: 0,
        registrations: [registration("notifications")],
      })
    ).toThrow(ModuleGatewayContractError);

    expect(() =>
      createModuleCapabilityCatalog({
        generation: 0,
        registrations: [registration(), registration()],
      })
    ).toThrow("registered more than once");
  });

  it("accepts equivalent schema values and rejects provider schema drift", () => {
    expect(() =>
      createModuleCapabilityCatalog({
        generation: 0,
        registrations: [
          {
            ...registration(),
            input: { ...schema, description: { ...emptySchema } },
          },
        ],
      })
    ).not.toThrow();

    const drifted = registration();
    expect(() =>
      createModuleCapabilityCatalog({
        generation: 0,
        registrations: [
          {
            ...drifted,
            input: {
              ...schema,
              description: { $schema: PORTABLE_SCHEMA_DIALECT, type: "string" },
            },
          },
        ],
      })
    ).toThrow("input schema disagrees");
  });
});
