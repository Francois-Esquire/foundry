import { canonicalizeJson } from "@foundry/lib/json";
import {
  CAPABILITY_NAME_PATTERN,
  capabilityIdentity,
  parsePortableSchema,
} from "../manifest";
import type {
  ModuleCapabilityCatalog,
  ModuleCapabilityDescriptor,
  ModuleCapabilityRegistration,
} from "./types";

export class ModuleGatewayContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleGatewayContractError";
  }
}

/** Projects portable catalog data from the registrations Gateway dispatches. */
export function createModuleCapabilityCatalog(input: {
  readonly generation: number;
  readonly registrations: readonly ModuleCapabilityRegistration[];
}): ModuleCapabilityCatalog {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new ModuleGatewayContractError(
      "Capability catalog generation must be a non-negative safe integer"
    );
  }

  const identities = new Set<string>();
  const descriptors = input.registrations.map((registration) => {
    const descriptor = catalogDescriptor(registration);
    const identity = capabilityIdentity(
      descriptor.capability,
      descriptor.version
    );
    if (identities.has(identity)) {
      throw new ModuleGatewayContractError(
        `Capability ${identity} is registered more than once`
      );
    }
    identities.add(identity);
    return Object.freeze(descriptor);
  });

  return Object.freeze({
    capabilities: Object.freeze(descriptors),
    generation: input.generation,
  });
}

function catalogDescriptor(
  registration: ModuleCapabilityRegistration
): ModuleCapabilityDescriptor {
  const { descriptor } = registration;
  if (!CAPABILITY_NAME_PATTERN.test(descriptor.capability)) {
    throw new ModuleGatewayContractError(
      `Capability ${JSON.stringify(descriptor.capability)} must be owner-namespaced`
    );
  }
  if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1) {
    throw new ModuleGatewayContractError(
      `Capability ${descriptor.capability} has an invalid version`
    );
  }
  if (descriptor.documentation.trim().length === 0) {
    throw new ModuleGatewayContractError(
      `Capability ${capabilityIdentity(descriptor.capability, descriptor.version)} requires documentation`
    );
  }
  parsePortableSchema(descriptor.input);
  parsePortableSchema(registration.input.description);
  if (!sameSchema(registration.input.description, descriptor.input)) {
    throw schemaDisagreement(descriptor, "input");
  }
  if (registration.mode === "unary") {
    const { output } = registration.descriptor;
    parsePortableSchema(output);
    parsePortableSchema(registration.output.description);
    if (!sameSchema(registration.output.description, output)) {
      throw schemaDisagreement(descriptor, "output");
    }
    return { ...registration.descriptor, mode: "unary" };
  }
  const { event } = registration.descriptor;
  parsePortableSchema(event);
  parsePortableSchema(registration.event.description);
  if (!sameSchema(registration.event.description, event)) {
    throw schemaDisagreement(descriptor, "event");
  }
  return { ...registration.descriptor, mode: "stream" };
}

function schemaDisagreement(
  descriptor: ModuleCapabilityRegistration["descriptor"],
  role: "input" | "output" | "event"
): ModuleGatewayContractError {
  return new ModuleGatewayContractError(
    `Capability ${capabilityIdentity(descriptor.capability, descriptor.version)} ${role} schema disagrees with its descriptor`
  );
}

function sameSchema(left: object, right: object): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}
