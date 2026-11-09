import { contentIdSchema } from "@foundry/artifacts";
import { digestJson } from "@foundry/lib/digest";
import { describe, expect, it } from "vitest";

import { installationIdSchema, moduleIdSchema } from "../domain";
import type { ModuleCapabilityProvider } from "../gateway/types";
import {
  carriedGrants,
  grantMatches,
  moduleAccessRequests,
  NETWORK_GRANT,
} from "../grants";
import { parseModuleManifest } from "../manifest";
import { STRICT_MANIFEST } from "./helpers/module-fixture";

const principal = {
  contentId: contentIdSchema.parse("content-1"),
  generation: 0,
  installationId: installationIdSchema.parse("notes"),
  moduleId: moduleIdSchema.parse("notes"),
};

function fetchProvider(digest: (constraints: unknown) => string) {
  return {
    registration: {
      descriptor: { capability: "host.network.fetch", version: 1 },
    },
    resolveConstraints: ({
      releaseConstraints,
    }: {
      releaseConstraints: unknown;
    }) => Promise.resolve({ constraintsDigest: digest(releaseConstraints) }),
  } as unknown as ModuleCapabilityProvider;
}

function version(change: object = {}) {
  return {
    manifest: parseModuleManifest({
      ...STRICT_MANIFEST,
      capabilities: [
        {
          alias: "weather",
          capability: "host.network.fetch",
          constraints: { hosts: ["api.example.com"] },
          reason: "Loads forecasts",
          required: true,
          version: 1,
        },
      ],
      ...change,
    }),
  };
}

const at = new Date(0);

describe("Module access requests and Grant carry-over", () => {
  it("resolves Capability requests through providers and the network request by its destinations", async () => {
    const requests = await moduleAccessRequests({
      principal,
      providers: [fetchProvider(() => "policy:forecast")],
      version: version(),
    });
    expect(requests).toEqual([
      {
        availability: "available",
        capability: "host.network.fetch",
        constraintsDigest: "policy:forecast",
        kind: "capability",
        reason: "Loads forecasts",
        request: version().manifest.capabilities[0],
        required: true,
        version: 1,
      },
      {
        availability: "available",
        capability: NETWORK_GRANT.capability,
        constraintsDigest: await digestJson(
          STRICT_MANIFEST.network.destinations
        ),
        destinations: STRICT_MANIFEST.network.destinations,
        kind: "network",
        reason: "Loads forecasts",
        required: false,
        version: 1,
      },
    ]);
    expect(
      await moduleAccessRequests({
        principal,
        providers: [],
        version: version(),
      })
    ).toMatchObject([{ availability: "unknown", constraintsDigest: null }, {}]);
  });

  it("denies a request whose provider resolves a blank digest, as invocation admission does", async () => {
    const [request] = await moduleAccessRequests({
      principal,
      providers: [fetchProvider(() => " ")],
      version: version(),
    });
    expect(request).toMatchObject({
      availability: "denied",
      constraintsDigest: null,
    });
  });

  it("carries over Grants whose capability, version and resolved digest are unchanged", async () => {
    const providers = [
      fetchProvider((constraints) => JSON.stringify(constraints)),
    ];
    const before = await moduleAccessRequests({
      principal,
      providers,
      version: version(),
    });
    const grants = before.flatMap((request) =>
      request.constraintsDigest === null
        ? []
        : [
            {
              capability: request.capability,
              constraintsDigest: request.constraintsDigest,
              createdAt: at,
              version: request.version,
            },
          ]
    );
    expect(grants).toHaveLength(2);

    // Same requests: both Grants carry over.
    expect(carriedGrants(grants, before)).toEqual(grants);

    // Changed destinations and changed constraints ask again.
    const changed = await moduleAccessRequests({
      principal,
      providers,
      version: version({
        capabilities: [
          {
            alias: "weather",
            capability: "host.network.fetch",
            constraints: { hosts: ["other.example.com"] },
            reason: "Loads forecasts",
            required: true,
            version: 1,
          },
        ],
        network: {
          destinations: [{ host: "other.example.com" }],
          reason: "Loads forecasts",
        },
      }),
    });
    expect(carriedGrants(grants, changed)).toEqual([]);

    // A new capability version asks again too.
    const bumped = await moduleAccessRequests({
      principal,
      providers: [],
      version: version({
        capabilities: [
          {
            alias: "weather",
            capability: "host.network.fetch",
            reason: "Loads forecasts",
            version: 2,
          },
        ],
      }),
    });
    expect(
      carriedGrants(grants, bumped).map((grant) => grant.capability)
    ).toEqual([NETWORK_GRANT.capability]);
    expect(
      grantMatches(
        {
          capability: "host.network.fetch",
          constraintsDigest: "x",
          version: 1,
        },
        { ...before[0], constraintsDigest: null } as never
      )
    ).toBe(false);
  });
});
