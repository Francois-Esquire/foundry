import { z } from "zod";
import { facetSchema } from "./facet";

export interface DomainDeclaration {
  domains?: DomainDeclaration[];
  facets?: string[];
  name: string;
  reason?: string;
  weight?: number;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const NAME_RULE =
  "must be lowercase letters, digits, and hyphens, starting with a letter";
const WEIGHT_RULE = "must be a number from 0 to 1";
const REASON_RULE =
  "must be non-empty text with no leading or trailing whitespace";
const OBJECT_RULE = "must be an object";
const MAX_NESTING = 64;
type IssuePath = (string | number)[];

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
  path: IssuePath;
  shown: string;
}

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

export const domainsSchema = z
  .unknown()
  .superRefine(checkNesting)
  .pipe(
    z
      .array(domainSchema, { error: "must be a list of domains" })
      .superRefine(checkNames)
  );
