# Atlas internal architecture foundation

## Boundary

V13 topology, V13.1 locality, and V13.2 responsibilities describe membership and relationships. They do
not change island coastlines, file coordinates, density, colors, or the current
neighborhood algorithm. Geometry and internal architecture are independent inputs
until the later placement phase.

## Ingestion

Each surveyed package has a documentation resource at
`/atlas-internals/<encoded-package-id>.json`, for example
`/atlas-internals/@foundry__ui.json`. These are static build outputs, computed
on request during development. Atlas startup does not fetch them.

The documentation app calls the library's public topology, locality, and responsibility analyzers
on the server. It uses package-local cache entries only when their fingerprint,
schema, and package identity match current inputs. Otherwise it analyzes current
package sources without writing the semantic cache or changing tooling.

Responses distinguish `available` from `unavailable`. Successful responses carry
the source fingerprint, local-report schema, cache/fresh provenance, and the
survey timestamp used for file matching. The timestamp describes the map survey,
not the age of the current source analysis. Source changes during analysis cause
`source-changed`, not a mixed report. Renamed packages report `package-changed`.
Missing packages and analysis failures remain
explicit rather than becoming empty architectural reports.

## Membership

The response preserves the library's topology, locality, and responsibility contracts, including
their schema versions, policies, hierarchy, roles, symbol consumers, and evidence
limitations. Path regions are observed path groupings, not inferred semantic
districts. Directory ancestry and region membership remain distinct views.

`bindInternals` joins package-relative module paths to existing repository-relative
atlas file paths. It returns module-to-file identities and explicit unmatched
files/modules. No filename-only matching, synthetic files, inferred ownership,
hash-based grouping, or forced assignment fills the gaps.

`scopeFileIds` resolves package, region, directory, or module membership to mapped
atlas file identities. Directory scopes include descendants and context files
such as tests and stories. The upstream locality scope's `modules` field describes
primary modules only; it must not be treated as a complete file inventory.

Neither function accepts coastline geometry or requires positions. Locality
describes observed consumption, not instructions to move a declaration.

## Responsibility inspection

Selecting Responsibilities in an island's margin fetches its evidence on demand.
Switching islands cancels the request. Failed requests offer retry; mismatched
package or survey identities require reloading rather than mixing evidence.

Selecting a responsibility highlights existing member files with amber rings.
Related members use teal rings; unresolved ownership uses broken rust diamonds.
Notches identify members outside their responsibility's dominant directory.
Import links appear on relationship selection or for unresolved affinities;
the strongest 24 mapped links are shown, with the full mapped count disclosed.
Other dependency overlays are suppressed during responsibility inspection.

The margin explains join evidence, path agreement, symbol crossings, and competing
affinities. These are observed structural tensions, not defects or a quality
score. Unresolved modules remain unassigned. Tests, stories, and configuration
remain visible without forced membership in source-only responsibilities.
File inspection retains the existing coordinates and selection behavior.

Responsibility identifiers hash membership and can change when membership changes.
They are not stable spatial anchors. Crowding alone cannot establish architectural
overpacking; capacity and placement diagnostics belong to the geometry-aware phase.

## Following phases

1. Extend evidence inspection as needed without moving files; responsibility
   membership and relationship inspection are implemented.
2. Compute settlement layout independently, using stable identities for seeds and
   tie-breaking, and observed hierarchy/relationships for belonging.
3. Add geometry-aware containment, clearance, capacity, and collision handling.
   Placement consumes coastlines; settlement coordinates never feed back into
   coastline generation.

Same inputs must reproduce the same result. Stability under small source changes
is a separate placement requirement, not something a hash guarantees.

## Open

The current survey can lag current package sources. Unmatched identities stay
visible until a new survey reconciles them. No geometric placement, symbol
relocation, ideal-architecture proposal, or capacity diagnosis is included.
