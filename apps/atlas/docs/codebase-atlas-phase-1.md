# Shape the archipelago

## Current status

Geography experiments rejected. File placement, package placement, radius budgets
and density contours are restored to the accepted first implementation at
`6b43e98a`. Noise, adaptive thresholds, landmark layout and final point packing
are removed. Neighborhood computation, filtering and evidence inspection remain,
but do not determine geography. Sections below record superseded experiments,
not current implementation requirements or guarantees.

Phase 1 refines the accepted island geography using the generated survey.
The comparison starts with Studio and db, its strongest observed module-import
connection in the current snapshot, then checks small and isolated packages.
Every package uses the same algorithm.

## Geographic meaning

| Evidence                                          | Geographic effect                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| File population                                   | Territory area budget grows with population.                                                    |
| Dependency layers                                 | Broad north/south orientation.                                                                  |
| Module imports and shared concepts                | Strongly related package coasts tend closer together, subject to space and other relationships. |
| Internal imports and shared concept participation | Computed file neighborhoods, including groups that cross directories.                           |
| Sparse or absent file relationships               | Ungrouped settlements; no invented architectural district.                                      |
| Solved file positions                             | Organic density contours, coastlines, bays and disconnected islands.                            |

Group names come from source paths and describe locations, not inferred domain
authority. Neighborhoods are a presentation hypothesis. Their members and
supporting import/concept counts must remain inspectable. Shared participation
does not imply runtime calls or semantic equivalence. Directory names do not
decide membership.

## Success conditions

- Reordered input records produce the same memberships, coordinates and contours.
- Every survey file appears once and remains selectable, including ungrouped files.
- Populated territories contain their settlements; contours never terminate at a
  clipped grid boundary. Empty referenced packages have no fabricated land.
- Stronger relationships reduce preferred separation in a controlled comparison.
  Real maps balance competing neighbors; proximity is not a ranking guarantee.
- Studio and db reveal useful neighborhoods without package-specific rules.
- Small or isolated packages remain readable and preserve honest missing evidence.

## Boundaries

Only documentation app and docs changes. No analyzer changes or dataset generation.
Material richness, lighting, substantial 3D terrain and level-of-detail exploration
remain subsequent phases. The current renderer already uses Three.js with an
orthographic tilt and shallow extruded coasts. Phase 2 should make that depth
tangible while preserving cartographic readability; elevation needs an explicit
meaning before it encodes any code metric.

Determinism is required now. Continuity across different snapshots remains Phase 4.
Agent activity, historical coupling forces and new persistent graph caches are out
of scope. Any numerical attraction weights are disclosed map rules, not analyzer
quality scores.

## Implemented rules

Each internal file pair receives one unit per distinct directed import, plus
half its shared-concept affinity, capped at half a unit. A concept contributes
`1 / (participant count - 1)` to each participating pair: broad concepts exert
less pairwise influence. Duplicate role participation adds no weight.

Neighborhoods use deterministic greedy positive modularity merges. For groups
A and B, the merge gain is proportional to their connecting weight minus
`degree(A) * degree(B) / total degree`. Remaining singletons are ungrouped.
This follows the [greedy modularity approach](https://arxiv.org/abs/cond-mat/0408187),
without claiming its optimized implementation. Names identify a representative
file, not a discovered domain boundary.

Package preferred gaps are `35 + 150 / (1 + log2(1 + imports) +
0.5 * log2(1 + shared concepts))` map units. Collision constraints can override
that preference. File population sets the local area budget; padded density
fields derive land from the solved settlements without clipping distant files.

## Verification

### File-level placement experiment

The first neighborhood-packing result was rejected visually: circular group
footprints produced repeated petals. The replacement removes all neighborhood
centers and radii from placement. Direct relationships and shortest-path distances
to up to 16 deterministic landmarks guide a file-level stress relaxation. Edge
length is inverse square-root attraction; target distance is eight map units per
weighted graph-distance unit. Collision spacing is 2.2 units before uniform fit.
No decorative noise is added. Disconnected locations remain identifier-seeded,
not evidence of relationships. This is not a guarantee of temporal stability or
globally optimal distances.

Density contours remain unchanged to isolate the placement experiment. On identical
UI, Studio and documentation-app positions, alpha-shape triangle boundaries at
radii 8 and 14 were angular and excluded isolated points from land. Those two
trials do not rule out other alpha settings or hybrid methods. They are not shipped.
Studio has irregular inlets; UI's dense core remains a legibility concern.
Visual acceptance is pending, and neighborhood counts alone do not validate shape.

Sixteen package tests cover ordering invariance, directory-independent placement, weighted relationships,
unsupported groups, disconnected contours, package separation and all surveyed
files remaining on land. Browser checks cover package and file selection,
neighborhood membership counts, evidence disclosure, dependency navigation and
mobile overflow. Desktop and mobile captures compare Studio, db and an isolated
package under the same algorithm.

In the September 4 survey, Studio has 57 computed neighborhoods and 157 ungrouped
files; db has 8 neighborhoods and 18 ungrouped files. These counts describe this
snapshot, not permanent architecture. Dense map labels are culled; the index
retains every neighborhood. Geographic continuity and richer 3D materials remain
unproven subsequent work.

## Coastal mass experiment

The file-level placement was not accepted visually. This next experiment holds
those positions fixed and changes only land generation. Fine file density and a
broader density contribution establish the overall mass. Three-scale seeded value
noise modifies the coastal band before contour extraction:

`mass = max(file protection, density * exp(strength * noise * edge band))`

`edge band = exp(-log(density / threshold)^2 / 2)`

The band fades in dense interiors and distant water. Noise amplitudes across
scales are 0.6, 0.28 and 0.12. The default land threshold is 0.65, noise strength
1.4 and noise scale 18 map units. Shallows and hills use 0.338 and 3.692 times the
land threshold on the same field. The file-protection floor preserves small land
patches around settlements; it does not move files. These are visual parameters,
not architectural metrics. Changing the threshold also recenters the edge band,
so variants are not guaranteed to be nested coastlines.

The comparison fixes positions for UI, Studio and documentation-app and shows
noise off at 0.65 beside noise-on thresholds 0.45, 0.65 and 0.85. Tests cover
ordering invariance, continuous repeatable noise, unchanged file positions and
file coverage across trial settings. No claim of visual acceptance or improved
central file density follows from these checks.

### Connection-modulated threshold

Superseded by connection-driven point spacing below. Retained as experiment history.

The base threshold is now 0.45. Each file's weighted internal degree becomes
`strength = degree / (degree + 4)`. The density-weighted local average determines
`local threshold = base threshold * (1.5 - 0.95 * local strength)`.
Unconnected locations therefore use 0.675; strongly connected ones approach
0.2475. No package-wide maximum normalization or final outline scaling is used.
Existing import and shared-concept attraction weights supply the degree.

The noisy density is divided by that multiplier before extracting the shared
contours. Noise's edge band remains based on the base threshold, so increasing
connections cannot reduce the sampled mass through noise-phase changes. File
protection is applied afterward. Saturation bounds each file's influence, and
the density kernel keeps it local. File coordinates remain unchanged; package
spacing may adjust to the larger coast radius.

A controlled fixed-position test checks increasing land area with stronger
connections, bounded hub expansion, unchanged remote unconnected coasts and
file coverage. The full survey coverage check includes the new modulation.

### Collision correction and connection-driven spread

The latest direction replaces connection-modulated coastline thresholds with
connection-driven point spread. The uniform base threshold remains 0.45.
Direct target lengths now increase logarithmically with edge weight and endpoint
weighted degree. Final placement reserves a radius of
`2.1 + 1.4 * degree / (degree + 4)` map units per file. Highly connected files
receive more clearance, not stronger compression.

The old collision pass allowed 6,267 overlapping rectangle pairs in UI and 292
in Studio. Its clearance was smaller than the mark footprint, moving points left
stale spatial buckets, and subsequent fitting could shrink the spacing again.
The final pass now places files against fixed occupied positions after fitting,
searching outward deterministically when space is occupied. Higher-degree files
are placed first. Only translation follows; coastlines derive from the result.
This avoids overlapping marks but can alter local graph distances and island shape.

The real-survey regression checks every file pair for at least 4.19 map units
of final center separation. A controlled test verifies stronger connections
increase spread. These checks are separate from aesthetic approval and label
placement, and do not promise readability at arbitrarily distant zoom.
