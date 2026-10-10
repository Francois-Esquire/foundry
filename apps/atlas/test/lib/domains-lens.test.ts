import { describe, expect, it } from "vitest";
import type { DomainDeclaration } from "../../src/lib/domain-declaration";
import type {
  DomainsSource,
  DomainsSourcePlacement,
} from "../../src/lib/lenses/domains";
import { domainsLens } from "../../src/lib/lenses/domains";
import type { LensReader } from "../../src/lib/lenses/lens-types";

function placed(
  place: string,
  level: DomainsSourcePlacement["level"],
  pkg: string,
  label: DomainsSourcePlacement["label"],
  away: string[],
  unindexed = 0
): DomainsSourcePlacement {
  return { away, label, level, package: pkg, place, unindexed };
}

/** Three packages: billing, a core of ids and money, and a checkout app. */
const SOURCE: DomainsSource = {
  files: [
    "apps/checkout/src/cart.ts",
    "apps/checkout/src/payments/pay.ts",
    "packages/billing/src/invoice.ts",
    "packages/core/src/ids.ts",
    "packages/core/src/money/total.ts",
  ],
  packages: ["apps/checkout", "packages/billing", "packages/core"],
  placements: [
    placed("packages/billing", "package", "@s/billing", "fits", [
      "apps/checkout/src/payments/pay.ts",
    ]),
    placed(
      "packages/core/src/ids.ts#InvoiceId",
      "symbol",
      "@s/core",
      "departs",
      ["packages/billing/src/invoice.ts"]
    ),
    placed("packages/core/src/ids.ts#UserId", "symbol", "@s/core", "departs", [
      "apps/checkout/src/cart.ts",
    ]),
    placed("packages/core/src/money/total.ts", "file", "@s/core", "spread", [
      "apps/checkout/src/cart.ts",
      "apps/checkout/src/payments/pay.ts",
    ]),
    // In no domain: its own path is named by none.
    placed("apps/checkout/src/cart.ts", "file", "@s/checkout", "departs", [
      "packages/core/src/ids.ts",
    ]),
    // Holds facets, but coverage runs downward only.
    placed("packages/core", "package", "@s/core", "departs", [
      "packages/billing/src/invoice.ts",
    ]),
  ],
  symbols: [
    "packages/core/src/ids.ts#InvoiceId",
    "packages/core/src/ids.ts#UserId",
    "packages/core/src/money/total.ts#total",
  ],
};

const DOMAINS: DomainDeclaration[] = [
  {
    domains: [
      {
        facets: [
          "packages/billing",
          "packages/core/src/ids.ts#InvoiceId",
          "packages/billing/src/legacy",
          "packages/core/src/ids.ts#OrderId",
        ],
        name: "billing",
        weight: 0.8,
      },
      {
        facets: ["apps/checkout/src/payments", "packages/core/src/money"],
        name: "payments",
      },
    ],
    name: "finances",
    reason: "Money moves through one model.",
  },
  { facets: ["packages/core/src/ids.ts"], name: "identity" },
];

describe("the domains lens", () => {
  it("matches each domain's facets to places, and reports those that name none", () => {
    expect(domainsLens.derive(SOURCE, { domains: DOMAINS }).domains).toEqual([
      {
        name: "billing",
        parents: ["finances"],
        places: [
          { kind: "package", place: "packages/billing" },
          { kind: "symbol", place: "packages/core/src/ids.ts#InvoiceId" },
        ],
        unmatched: [
          "packages/billing/src/legacy",
          "packages/core/src/ids.ts#OrderId",
        ],
        weight: 0.8,
      },
      {
        name: "finances",
        parents: [],
        places: [],
        reason: "Money moves through one model.",
        unmatched: [],
      },
      {
        name: "identity",
        parents: [],
        places: [{ kind: "file", place: "packages/core/src/ids.ts" }],
        unmatched: [],
      },
      {
        name: "payments",
        parents: ["finances"],
        places: [
          { kind: "folder", place: "apps/checkout/src/payments" },
          { kind: "folder", place: "packages/core/src/money" },
        ],
        unmatched: [],
      },
    ]);
  });

  it("shares a domain only when every away consumer does, and keeps the placement label beside it", () => {
    expect(domainsLens.derive(SOURCE, { domains: DOMAINS }).placements).toEqual(
      [
        // A fit stays a fit, whatever its consumers share.
        {
          away: { shared: 1, total: 1, unindexed: 0 },
          domainLabel: "fits",
          domains: ["billing", "finances"],
          level: "package",
          package: "@s/billing",
          place: "packages/billing",
          placementLabel: "fits",
          sharedDomains: ["finances"],
        },
        {
          away: { shared: 1, total: 1, unindexed: 0 },
          domainLabel: "shares-domain",
          domains: ["billing", "finances", "identity"],
          level: "symbol",
          package: "@s/core",
          place: "packages/core/src/ids.ts#InvoiceId",
          placementLabel: "departs",
          sharedDomains: ["billing", "finances"],
        },
        // A domain departure as well as a placement departure.
        {
          away: { shared: 0, total: 1, unindexed: 0 },
          domainLabel: "departs",
          domains: ["identity"],
          level: "symbol",
          package: "@s/core",
          place: "packages/core/src/ids.ts#UserId",
          placementLabel: "departs",
          sharedDomains: [],
        },
        // One away consumer of two shares a domain: still spread.
        {
          away: { shared: 1, total: 2, unindexed: 0 },
          domainLabel: "spread",
          domains: ["finances", "payments"],
          level: "file",
          package: "@s/core",
          place: "packages/core/src/money/total.ts",
          placementLabel: "spread",
          sharedDomains: ["finances", "payments"],
        },
      ]
    );
  });

  it("labels nothing and matches nothing when no domain is declared", () => {
    expect(domainsLens.derive(SOURCE, { domains: [] })).toEqual({
      domains: [],
      placements: [],
    });
  });

  it("names a package's path a package before a folder, and a place at two levels twice", () => {
    const { domains, placements } = domainsLens.derive(
      {
        files: ["packages/o/nested/src/a.ts", "packages/o/src/b.ts"],
        packages: ["packages/o", "packages/o/nested"],
        placements: [
          placed("packages/o/nested", "package", "@s/n", "departs", [
            "packages/o/src/b.ts",
          ]),
          placed("packages/o/nested", "folder", "@s/o", "departs", [
            "packages/o/src/b.ts",
          ]),
        ],
        symbols: [],
      },
      { domains: [{ facets: ["packages/o", "packages/o/src"], name: "o" }] }
    );
    expect(domains[0]?.places).toEqual([
      { kind: "package", place: "packages/o" },
      { kind: "folder", place: "packages/o/src" },
    ]);
    expect(
      placements.map((placement) => [
        placement.level,
        placement.package,
        placement.domainLabel,
      ])
    ).toEqual([
      ["folder", "@s/o", "shares-domain"],
      ["package", "@s/n", "shares-domain"],
    ]);
  });

  it("gives the same output whatever the order of its inputs", () => {
    const shuffled: DomainsSource = {
      files: [...SOURCE.files].reverse(),
      packages: [...SOURCE.packages].reverse(),
      placements: [...SOURCE.placements].reverse(),
      symbols: [...SOURCE.symbols].reverse(),
    };
    const reordered = [...DOMAINS].reverse();
    expect(
      JSON.stringify(domainsLens.derive(shuffled, { domains: reordered }))
    ).toBe(JSON.stringify(domainsLens.derive(SOURCE, { domains: DOMAINS })));
  });

  it("withholds shares-domain from a place with a consumer outside the module index", () => {
    // A file of a package that failed, say: its domains cannot be told.
    const [row] = domainsLens.derive(
      {
        ...SOURCE,
        placements: [
          placed(
            "packages/core/src/ids.ts#InvoiceId",
            "symbol",
            "@s/core",
            "departs",
            ["packages/billing/src/invoice.ts"],
            1
          ),
        ],
      },
      { domains: DOMAINS }
    ).placements;
    expect(row).toMatchObject({
      away: { shared: 1, total: 1, unindexed: 1 },
      domainLabel: "departs",
      placementLabel: "departs",
      sharedDomains: ["billing", "finances"],
    });
  });

  it("shares a domain through the parent of two sibling domains", () => {
    const { placements } = domainsLens.derive(
      {
        files: ["apps/shop/src/cart.ts", "packages/pay/src/card.ts"],
        packages: ["apps/shop", "packages/pay"],
        placements: [
          placed("packages/pay/src/card.ts", "file", "@s/pay", "departs", [
            "apps/shop/src/cart.ts",
          ]),
          placed("packages/pay", "package", "@s/pay", "spread", [
            "apps/shop/src/cart.ts",
          ]),
        ],
        symbols: [],
      },
      {
        domains: [
          {
            domains: [
              { facets: ["packages/pay"], name: "payments" },
              { facets: ["apps/shop"], name: "shopping" },
            ],
            name: "commerce",
          },
        ],
      }
    );
    expect(
      placements.map((placement) => [
        placement.place,
        placement.domains,
        placement.sharedDomains,
        placement.domainLabel,
      ])
    ).toEqual([
      ["packages/pay", ["commerce", "payments"], ["commerce"], "shares-domain"],
      [
        "packages/pay/src/card.ts",
        ["commerce", "payments"],
        ["commerce"],
        "shares-domain",
      ],
    ]);
  });

  it("matches a facet on a symbol its module does not export, which placement gives no row", () => {
    // The report lists every top-level declaration; placement only the exported.
    const lens = domainsLens.derive(
      {
        files: ["packages/core/src/ids.ts"],
        packages: ["packages/core"],
        placements: [],
        symbols: ["packages/core/src/ids.ts#hidden"],
      },
      {
        domains: [
          { facets: ["packages/core/src/ids.ts#hidden"], name: "identity" },
        ],
      }
    );
    expect(lens.domains[0]?.places).toEqual([
      { kind: "symbol", place: "packages/core/src/ids.ts#hidden" },
    ]);
    expect(lens.placements).toEqual([]);
  });

  it("reads nothing when no domain is declared", async () => {
    const reads: string[] = [];
    const reader = new Proxy(
      {},
      {
        get: (_target, method: string) => () => {
          reads.push(method);
          return Promise.resolve(undefined);
        },
      }
    ) as LensReader;
    expect(await domainsLens.read(reader, { domains: [] })).toEqual({
      files: [],
      packages: [],
      placements: [],
      symbols: [],
    });
    expect(reads).toEqual([]);
  });

  it("reads the placement lens, and only the reports of the packages holding a symbol facet's file, one at a time", async () => {
    let reading = 0;
    let mostAtOnce = 0;
    const reports: string[] = [];
    const reader = {
      lens: (id: string) =>
        Promise.resolve(
          id === "placement"
            ? {
                missing: [],
                packages: [],
                places: [
                  {
                    away: [
                      { modules: ["apps/a/src/index.ts"], package: "@s/a" },
                      { modules: ["tooling/c/src/index.ts"], package: "@s/c" },
                    ],
                    home: { modules: ["packages/b/src/x.ts"] },
                    label: "spread",
                    level: "file",
                    package: "@s/b",
                    place: "packages/b/src/shape.ts",
                    unindexed: 1,
                  },
                ],
                policy: { dominantShare: 0.6 },
              }
            : undefined
        ),
      moduleIndex: () =>
        Promise.resolve({
          modules: [
            {
              fileKind: "source",
              id: "packages/b/src/shape.ts",
              package: "@s/b",
              path: "packages/b/src/shape.ts",
              shard: "modules/@s__b.json",
            },
          ],
        }),
      packageReport: async (id: string) => {
        reports.push(id);
        reading += 1;
        mostAtOnce = Math.max(mostAtOnce, reading);
        await new Promise((resolve) => setTimeout(resolve, 1));
        reading -= 1;
        return {
          churn: "a large field the lens never reads",
          symbols: [
            // Not exported, so not placed; a facet can still name it.
            { exported: false, id: `${id}.ts#hidden`, kind: "function" },
          ],
        };
      },
      packages: () => [
        { id: "@s/b", internals: true, path: "packages/b", status: "complete" },
        {
          id: "@s/n",
          internals: true,
          path: "packages/b/nested",
          status: "complete",
        },
        { id: "@s/o", internals: true, path: "packages/o", status: "complete" },
        { id: "@s/root", internals: false, path: "", status: "complete" },
        { id: "@s/f", internals: false, path: "packages/f", status: "failed" },
      ],
    } as unknown as LensReader;
    const settings = {
      domains: [
        {
          facets: [
            // Path facets need no report.
            "packages/o",
            "packages/b/src/shape.ts",
            // The deepest root holding the file owns it: @s/n, not @s/b.
            "packages/b/nested/src/n.ts#n",
            "packages/b/nested/src/m.ts#m",
            // A failed package has no report.
            "packages/f/src/f.ts#f",
          ],
          name: "shapes",
        },
      ],
    };
    expect(await domainsLens.read(reader, settings)).toEqual({
      files: ["packages/b/src/shape.ts"],
      packages: ["packages/b", "packages/b/nested", "packages/o"],
      placements: [
        {
          away: ["apps/a/src/index.ts", "tooling/c/src/index.ts"],
          label: "spread",
          level: "file",
          package: "@s/b",
          place: "packages/b/src/shape.ts",
          unindexed: 1,
        },
      ],
      symbols: ["@s/n.ts#hidden"],
    });
    expect(reports).toEqual(["@s/n"]);
    expect(mostAtOnce).toBe(1);
  });

  it("reads the one report a single symbol facet names", async () => {
    const reports: string[] = [];
    const reader = {
      lens: () => Promise.resolve({ places: [] }),
      moduleIndex: () => Promise.resolve({ modules: [] }),
      packageReport: (id: string) => {
        reports.push(id);
        return Promise.resolve({ symbols: [] });
      },
      packages: () => [
        { id: "@s/a", internals: true, path: "apps/a", status: "complete" },
        { id: "@s/b", internals: true, path: "packages/b", status: "complete" },
        { id: "@s/c", internals: true, path: "tooling/c", status: "complete" },
      ],
    } as unknown as LensReader;
    await domainsLens.read(reader, {
      domains: [{ facets: ["packages/b/src/shape.ts#area"], name: "shapes" }],
    });
    expect(reports).toEqual(["@s/b"]);
  });

  it.each([
    // The workspace root is depth 0, below a one-segment root of one letter.
    [".", "b", "b/x.ts#X"],
    // packages/a is no root of packages/ab.
    ["packages/a", "packages/ab", "packages/ab/x.ts#X"],
  ])(
    "reads only the package whose root holds the facet's file: %s and %s",
    async (outer, owner, facet) => {
      const reports: string[] = [];
      const reader = {
        lens: () => Promise.resolve({ places: [] }),
        moduleIndex: () => Promise.resolve({ modules: [] }),
        packageReport: (id: string) => {
          reports.push(id);
          return Promise.resolve({ symbols: [] });
        },
        // Listed first, so the manifest's order would favour it on a tie.
        packages: () => [
          { id: outer, internals: true, path: outer, status: "complete" },
          { id: owner, internals: true, path: owner, status: "complete" },
        ],
      } as unknown as LensReader;
      await domainsLens.read(reader, {
        domains: [{ facets: [facet], name: "x" }],
      });
      expect(reports).toEqual([owner]);
    }
  );
});
