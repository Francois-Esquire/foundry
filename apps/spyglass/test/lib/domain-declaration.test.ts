import { expect, it } from "vitest";
import { parseConfigFile } from "../../src/lib/spyglass-config";

// Domains are validated as part of a configuration file's default export,
// so these tests go through the same parse the loader runs on each file.

const FILE = ".foundry/spyglass/domains.ts";

function domains(value: unknown): unknown {
  return parseConfigFile({ domains: value }, FILE).domains;
}

function rejection(value: unknown): string {
  try {
    domains(value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the domains were accepted");
}

it("accepts nested domains with facets, weights, and reasons, as written", () => {
  const declared = [
    {
      domains: [
        {
          facets: ["packages/billing", "packages/core/src/ids.ts#InvoiceId"],
          name: "billing",
          weight: 1,
        },
        { facets: ["apps/checkout/src/payments"], name: "payments" },
      ],
      name: "finances",
      reason: "Money moves through one model.",
      weight: 0,
    },
  ];
  expect(domains(declared)).toEqual(declared);
});

it("accepts a facet in more than one domain, and a domain of only domains", () => {
  const declared = [
    { facets: ["packages/core/src/money.ts"], name: "billing" },
    {
      domains: [{ facets: ["packages/core/src/money.ts"], name: "audit" }],
      name: "compliance",
    },
  ];
  expect(domains(declared)).toEqual(declared);
});

it("accepts the paths of route folders and any case", () => {
  const facets = [
    "apps/web/app/[id]/page.tsx",
    "apps/web/app/(shop)/{slot}",
    "packages/Core/src/IDs.ts#$Invoice_Id",
    "packages/core/src/ids.ts#Café",
  ];
  expect(domains([{ facets, name: "routes" }])).toEqual([
    { facets, name: "routes" },
  ]);
});

it("accepts an empty list of domains", () => {
  expect(domains([])).toEqual([]);
});

it.each([
  ["", 'domains[0].facets[0] must be a workspace-relative path; got "".'],
  [
    "packages\\billing",
    'domains[0].facets[0] must use "/" as the separator; got "packages\\\\billing".',
  ],
  [
    "/packages/billing",
    'domains[0].facets[0] must be relative to the workspace root; got "/packages/billing".',
  ],
  [
    "C:/billing",
    'domains[0].facets[0] must be relative to the workspace root; got "C:/billing".',
  ],
  [
    "packages/*/src",
    'domains[0].facets[0] must not use "*", "?", or a leading "!", which are reserved for patterns; got "packages/*/src".',
  ],
  [
    "packages/bill?ng",
    'domains[0].facets[0] must not use "*", "?", or a leading "!", which are reserved for patterns; got "packages/bill?ng".',
  ],
  [
    "!packages/billing",
    'domains[0].facets[0] must not use "*", "?", or a leading "!", which are reserved for patterns; got "!packages/billing".',
  ],
  [
    "packages/billing/",
    'domains[0].facets[0] must have no empty, ".", or ".." segments, and no trailing "/"; got "packages/billing/".',
  ],
  [
    "packages//billing",
    'domains[0].facets[0] must have no empty, ".", or ".." segments, and no trailing "/"; got "packages//billing".',
  ],
  [
    "./packages/billing",
    'domains[0].facets[0] must have no empty, ".", or ".." segments, and no trailing "/"; got "./packages/billing".',
  ],
  [
    "packages/../billing",
    'domains[0].facets[0] must have no empty, ".", or ".." segments, and no trailing "/"; got "packages/../billing".',
  ],
  [
    "#InvoiceId",
    'domains[0].facets[0] must name a file before "#"; got "#InvoiceId".',
  ],
  [
    " packages/billing",
    'domains[0].facets[0] must have no leading or trailing whitespace; got " packages/billing".',
  ],
  [
    "packages/billing\n",
    'domains[0].facets[0] must have no leading or trailing whitespace; got "packages/billing\\n".',
  ],
  [
    "src/ids.ts#InvoiceId#id",
    'domains[0].facets[0] must name at most one symbol, after one "#"; got "src/ids.ts#InvoiceId#id".',
  ],
  [
    "src/ids.ts#",
    'domains[0].facets[0] must name one top-level declaration after "#"; got "src/ids.ts#".',
  ],
  [
    "src/ids.ts#Invoice.id",
    'domains[0].facets[0] must name one top-level declaration after "#"; got "src/ids.ts#Invoice.id".',
  ],
  [
    "src/ids.ts#1st",
    'domains[0].facets[0] must name one top-level declaration after "#"; got "src/ids.ts#1st".',
  ],
])("rejects the facet %j, naming the file and the setting", (facet, issue) => {
  expect(rejection([{ facets: [facet], name: "billing" }])).toBe(
    `Configuration ${FILE}: ${issue}`
  );
});

it("names every invalid facet, nested domains included, by its path", () => {
  expect(
    rejection([
      {
        domains: [
          { facets: ["packages/ok", "/abs"], name: "billing" },
          { facets: ["a\\b"], name: "payments" },
        ],
        name: "finances",
      },
    ])
  ).toBe(
    `Configuration ${FILE}: domains[0].domains[0].facets[1] must be relative to the workspace root; got "/abs"; domains[0].domains[1].facets[0] must use "/" as the separator; got "a\\\\b".`
  );
});

it.each([
  "Billing",
  "billing domain",
  "1billing",
  "-billing",
  "billing_core",
  "",
])("rejects the domain name %j", (name) => {
  expect(rejection([{ facets: ["packages/billing"], name }])).toBe(
    `Configuration ${FILE}: domains[0].name must be lowercase letters, digits, and hyphens, starting with a letter; got ${JSON.stringify(name)}.`
  );
});

it("requires a name", () => {
  expect(rejection([{ facets: ["packages/billing"] }])).toBe(
    `Configuration ${FILE}: domains[0].name must be lowercase letters, digits, and hyphens, starting with a letter; got nothing.`
  );
});

it("rejects a domain with no facets and no domains, and says its path need not exist", () => {
  expect(rejection([{ name: "billing" }])).not.toContain("got");
  const message = `Configuration ${FILE}: domains[0] declares no facets and no domains, so add a facet, whose path need not exist yet.`;
  expect(rejection([{ name: "billing" }])).toBe(message);
  expect(rejection([{ domains: [], facets: [], name: "billing" }])).toBe(
    message
  );
  expect(
    rejection([{ domains: [{ name: "payments" }], name: "finances" }])
  ).toBe(
    `Configuration ${FILE}: domains[0].domains[0] declares no facets and no domains, so add a facet, whose path need not exist yet.`
  );
});

it("rejects a facet listed twice in one domain", () => {
  expect(
    rejection([
      {
        facets: ["packages/billing", "packages/core", "packages/billing"],
        name: "billing",
      },
    ])
  ).toBe(
    `Configuration ${FILE}: domains[0].facets[2] repeats a facet this domain already lists; got "packages/billing".`
  );
});

it("rejects a name used twice, between siblings and across nesting", () => {
  expect(
    rejection([
      { facets: ["packages/billing"], name: "billing" },
      { facets: ["apps/billing"], name: "billing" },
    ])
  ).toBe(
    `Configuration ${FILE}: domains[1].name repeats the name of domains[0]; got "billing".`
  );
  expect(
    rejection([
      {
        domains: [{ facets: ["packages/billing"], name: "billing" }],
        name: "finances",
      },
      {
        domains: [{ facets: ["apps/legal/billing"], name: "billing" }],
        name: "legal",
      },
    ])
  ).toBe(
    `Configuration ${FILE}: domains[1].domains[0].name repeats the name of domains[0].domains[0]; got "billing".`
  );
  expect(
    rejection([
      {
        domains: [{ facets: ["packages/billing"], name: "finances" }],
        name: "finances",
      },
    ])
  ).toBe(
    `Configuration ${FILE}: domains[0].domains[0].name repeats the name of domains[0]; got "finances".`
  );
});

it.each([
  [-0.1, "-0.1"],
  [1.1, "1.1"],
  ["1", '"1"'],
])("rejects the weight %j", (weight, shown) => {
  expect(
    rejection([{ facets: ["packages/billing"], name: "billing", weight }])
  ).toBe(
    `Configuration ${FILE}: domains[0].weight must be a number from 0 to 1; got ${shown}.`
  );
});

it.each(["", " ", " Money moves."])("rejects the reason %j", (reason) => {
  expect(
    rejection([{ facets: ["packages/billing"], name: "billing", reason }])
  ).toBe(
    `Configuration ${FILE}: domains[0].reason must be non-empty text with no leading or trailing whitespace; got ${JSON.stringify(reason)}.`
  );
});

it("rejects unknown keys and values of the wrong shape", () => {
  expect(
    rejection([{ facets: ["packages/billing"], kind: "core", name: "billing" }])
  ).toBe(`Configuration ${FILE}: domains[0] has unknown key kind.`);
  expect(rejection({ billing: ["packages/billing"] })).toBe(
    `Configuration ${FILE}: domains must be a list of domains; got an object.`
  );
  expect(rejection(["billing"])).toBe(
    `Configuration ${FILE}: domains[0] must be an object; got "billing".`
  );
  expect(rejection([{ facets: "packages/billing", name: "billing" }])).toBe(
    `Configuration ${FILE}: domains[0].facets must be a list of facets; got "packages/billing".`
  );
});

it("names a domain that contains itself, and one object listed twice, without walking them", () => {
  const finances: Record<string, unknown> = {
    domains: [] as unknown[],
    facets: ["packages/billing"],
    name: "finances",
  };
  (finances.domains as unknown[]).push(finances);
  expect(rejection([finances])).toBe(
    `Configuration ${FILE}: domains[0].domains[0] contains itself.`
  );
  const shared = { facets: ["packages/core"], name: "core" };
  expect(
    rejection([
      { domains: [shared], name: "finances" },
      { domains: [shared], name: "legal" },
    ])
  ).toBe(
    `Configuration ${FILE}: domains[1].domains[0] repeats the domain at domains[0].domains[0].`
  );
});

it("accepts 64 nested domains and names the 65th", () => {
  const chain = (depth: number): Record<string, unknown> => {
    let domain: Record<string, unknown> = {
      facets: ["packages/core"],
      name: `d${depth}`,
    };
    for (let level = depth - 1; level >= 1; level -= 1) {
      domain = { domains: [domain], name: `d${level}` };
    }
    return domain;
  };
  expect(() => domains([chain(64)])).not.toThrow();
  expect(rejection([chain(65)])).toBe(
    `Configuration ${FILE}: domains[0]${".domains[0]".repeat(64)} nests deeper than 64 domains.`
  );
});
