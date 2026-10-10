import { z } from "zod";
import { facetSchema } from "./facet";

// The domain declaration: how a workspace tells Atlas its own mental model.
// A configuration file declares it under `domains`. It is kept as written,
// read by no analysis, and left out of the configuration fingerprint, so a
// scan with new domains reuses every package's results. The domains lens
// (lib/lenses/domains.ts) reads it; see docs/atlas/_domains.md.

/** One domain, as a configuration file declares it under `domains`. */
export interface DomainDeclaration {
  /** Domains nested inside this one. A place in a nested domain is in this one too. */
  domains?: DomainDeclaration[];
  /**
   * The places this domain names as its own: a package, folder, or file by
   * its workspace-relative path, or a top-level symbol as `path#name`. A
   * facet's path need not exist.
   */
  facets?: string[];
  /** The domain's id: lowercase letters, digits, and hyphens, unique across the workspace. */
  name: string;
  /** Why the workspace declares it, reported as written. */
  reason?: string;
  /** The workspace's own emphasis, 0 to 1, reported as written; how weights combine is not decided. */
  weight?: number;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const NAME_RULE =
  "must be lowercase letters, digits, and hyphens, starting with a letter";
const WEIGHT_RULE = "must be a number from 0 to 1";
const REASON_RULE =
  "must be non-empty text with no leading or trailing whitespace";
const OBJECT_RULE = "must be an object";
/** Deeper than any model a workspace writes by hand; a cycle built in code is caught first. */
const MAX_NESTING = 64;
type IssuePath = (string | number)[];

/**
 * An issue about a whole domain, which its message names; the configuration
 * error shows no "got" for it (`atlas-config.ts`).
 */
function addDomainIssue(
  context: z.RefinementCtx,
  domain: object,
  message: string,
  path: IssuePath = []
): void {
  context.addIssue({
    code: "custom",
    input: domain,
    message,
    params: { wholeObject: true },
    path,
  });
}

/** Within one domain: something to name, and no facet listed twice. */
function checkDomain(
  domain: DomainDeclaration,
  context: z.RefinementCtx
): void {
  const facets = domain.facets ?? [];
  if (facets.length === 0 && (domain.domains ?? []).length === 0) {
    addDomainIssue(
      context,
      domain,
      "declares no facets and no domains, so add a facet, whose path need not exist yet"
    );
  }
  const listed = new Set<string>();
  for (const [index, facet] of facets.entries()) {
    if (listed.has(facet)) {
      context.addIssue({
        code: "custom",
        input: facet,
        message: "repeats a facet this domain already lists",
        path: ["facets", index],
      });
    }
    listed.add(facet);
  }
}

const domainSchema: z.ZodType<DomainDeclaration> = z
  .strictObject(
    {
      get domains(): z.ZodOptional<z.ZodArray<z.ZodType<DomainDeclaration>>> {
        return z
          .array(domainSchema, { error: "must be a list of domains" })
          .optional();
      },
      facets: z
        .array(facetSchema, { error: "must be a list of facets" })
        .optional(),
      name: z.string({ error: NAME_RULE }).regex(NAME, { error: NAME_RULE }),
      reason: z
        .string({ error: REASON_RULE })
        .refine((reason) => reason !== "" && reason.trim() === reason, {
          error: REASON_RULE,
        })
        .optional(),
      weight: z
        .number({ error: WEIGHT_RULE })
        .min(0, { error: WEIGHT_RULE })
        .max(1, { error: WEIGHT_RULE })
        .optional(),
    },
    { error: OBJECT_RULE }
  )
  .superRefine(checkDomain);

interface PlacedDomain {
  domain: DomainDeclaration;
  /** Relative to the top-level list: `[0, "domains", 1]`. */
  path: IssuePath;
  /** As a configuration error shows it: `domains[0].domains[1]`. */
  shown: string;
}

/** Every domain in the tree, parents before the domains nested inside them. */
function* placedDomains(
  domains: readonly DomainDeclaration[],
  path: IssuePath = [],
  shown = "domains"
): Generator<PlacedDomain> {
  for (const [index, domain] of domains.entries()) {
    const placed = {
      domain,
      path: [...path, index],
      shown: `${shown}[${index}]`,
    };
    yield placed;
    yield* placedDomains(
      domain.domains ?? [],
      [...placed.path, "domains"],
      `${placed.shown}.domains`
    );
  }
}

/** Across the whole tree: a name is an id, so no two domains share one. */
function checkNames(
  domains: readonly DomainDeclaration[],
  context: z.RefinementCtx
): void {
  const first = new Map<string, string>();
  for (const { domain, path, shown } of placedDomains(domains)) {
    const earlier = first.get(domain.name);
    if (earlier === undefined) {
      first.set(domain.name, shown);
      continue;
    }
    context.addIssue({
      code: "custom",
      input: domain.name,
      message: `repeats the name of ${earlier}`,
      path: [...path, "name"],
    });
  }
}

/** Why a domain cannot be nested where it is; undefined when it can. */
function nestingIssue(
  domain: object,
  enclosing: ReadonlySet<object>,
  placed: ReadonlyMap<object, string>
): string | undefined {
  if (enclosing.has(domain)) {
    return "contains itself";
  }
  const earlier = placed.get(domain);
  if (earlier !== undefined) {
    return `repeats the domain at ${earlier}`;
  }
  if (enclosing.size >= MAX_NESTING) {
    return `nests deeper than ${MAX_NESTING} domains`;
  }
}

/**
 * Before the schema walks the tree: a configuration file is code, so its
 * domains can hold themselves or nest without end, which would exhaust the
 * stack. One object listed twice is refused too, so the walk stays linear.
 */
function checkNesting(value: unknown, context: z.RefinementCtx): void {
  const enclosing = new Set<object>();
  const placed = new Map<object, string>();
  const visit = (list: unknown, path: IssuePath, shown: string): void => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const [index, domain] of list.entries()) {
      if (typeof domain !== "object" || domain === null) {
        continue;
      }
      const here = [...path, index];
      const message = nestingIssue(domain, enclosing, placed);
      if (message !== undefined) {
        addDomainIssue(context, domain, message, here);
        continue;
      }
      placed.set(domain, `${shown}[${index}]`);
      enclosing.add(domain);
      visit(
        (domain as { domains?: unknown }).domains,
        [...here, "domains"],
        `${shown}[${index}].domains`
      );
      enclosing.delete(domain);
    }
  };
  visit(value, [], "domains");
}

/** The `domains` setting of a configuration file. */
export const domainsSchema = z
  .unknown()
  .superRefine(checkNesting)
  .pipe(
    z
      .array(domainSchema, { error: "must be a list of domains" })
      .superRefine(checkNames)
  );
