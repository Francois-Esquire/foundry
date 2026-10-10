import type {
  DomainLabel,
  DomainMatch,
  DomainPlacement,
  Domains,
} from "../../lenses/domains-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { LISTED_AT_DENSITY } from "../context";
import { count } from "../format";
import type { BlockView, ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** The places listed by domain label, a domain departure apart from a placement departure. */
const LISTED: { label: DomainLabel; title: string }[] = [
  { label: "shares-domain", title: "Shares a domain" },
  { label: "departs", title: "Domain departures" },
  { label: "spread", title: "Spread" },
];

function labelled(placements: DomainPlacement[], label: DomainLabel): number {
  return placements.filter((placement) => placement.domainLabel === label)
    .length;
}

/** Where a domain sits and what it declares beyond its facets. */
function domainDetail(domain: DomainMatch): string[] {
  const facts = [
    ...(domain.parents.length > 0 ? [`in ${domain.parents.join(" › ")}`] : []),
    ...(domain.weight === undefined ? [] : [`weight ${domain.weight}`]),
    ...(domain.unmatched.length > 0
      ? [`${count(domain.unmatched.length)} unmatched`]
      : []),
  ];
  return [
    ...(facts.length > 0 ? [facts.join(" · ")] : []),
    ...(domain.reason === undefined ? [] : [domain.reason]),
  ];
}

function placementDetail(placement: DomainPlacement): string {
  const { shared, total, unindexed } = placement.away;
  const sharing =
    placement.sharedDomains.length > 0
      ? `${count(shared)} of ${count(total)} away share ${placement.sharedDomains.join(", ")}`
      : `none of ${count(total)} away shares its domains`;
  const unseen = unindexed > 0 ? ` · ${count(unindexed)} unindexed` : "";
  return `${placement.level} · ${placement.package} · placement ${placement.placementLabel} · ${sharing}${unseen}`;
}

/** Places of one domain label, the most consumer modules away first, then by place. */
function placesSection(
  placements: DomainPlacement[],
  label: DomainLabel,
  title: string,
  density: RenderDensity
): SectionView | undefined {
  return rankedSection(
    placements
      .filter((placement) => placement.domainLabel === label)
      .sort((a, b) => b.away.total - a.away.total || byId(a.place, b.place))
      .map((placement) => ({
        detail: [placementDetail(placement)],
        label: placement.place,
        value: placement.away.total,
      })),
    density,
    title
  );
}

function unmatchedSection(
  domains: DomainMatch[],
  density: RenderDensity
): SectionView | undefined {
  const facets = domains.flatMap((domain) =>
    domain.unmatched.map((facet) => `${domain.name}: ${facet}`)
  );
  const shown = facets.slice(0, LISTED_AT_DENSITY[density]);
  if (shown.length === 0) {
    return;
  }
  const list: BlockView = {
    items: shown,
    kind: "list",
    ...(facets.length > shown.length && {
      overflow: facets.length - shown.length,
    }),
  };
  return { blocks: [list], title: "Unmatched facets" };
}

/** The `domains` lens: counts, the domains by name, places by domain label, then the facets that name no place. */
export function buildDomainsView(
  lens: Domains,
  density: RenderDensity
): ReportView {
  const { domains, placements } = lens;
  if (domains.length === 0) {
    return {
      sections: [
        { blocks: [{ kind: "text", lines: ["No domains declared."] }] },
      ],
      title: "Domains",
    };
  }
  const matched = domains.reduce(
    (sum, domain) => sum + domain.places.length,
    0
  );
  const unmatched = domains.reduce(
    (sum, domain) => sum + domain.unmatched.length,
    0
  );
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            { label: "Domains", value: count(domains.length) },
            {
              label: "Facets",
              value: `${count(matched)} matched, ${count(unmatched)} unmatched`,
            },
            {
              label: "Places in a domain",
              value: `${count(labelled(placements, "shares-domain"))} share a domain, ${count(labelled(placements, "departs"))} depart, ${count(labelled(placements, "spread"))} spread, ${count(labelled(placements, "fits"))} fit`,
            },
          ],
        },
      ],
    },
  ];
  const listed = [
    rankedSection(
      domains.map((domain) => ({
        detail: domainDetail(domain),
        label: domain.name,
        value: domain.places.length,
      })),
      density,
      "Declared domains"
    ),
    ...LISTED.map(({ label, title }) =>
      placesSection(placements, label, title, density)
    ),
    unmatchedSection(domains, density),
  ];
  for (const section of listed) {
    if (section !== undefined) {
      sections.push(section);
    }
  }
  return { sections, title: "Domains" };
}
