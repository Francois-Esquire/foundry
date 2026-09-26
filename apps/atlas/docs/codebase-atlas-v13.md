# Atlas V13 work log

## Accepted direction

Preserve the paper atlas, ocean, coastlines, and package geography. Change how
architecture is revealed inside islands. This log separates shipped behavior
from experiments and remaining work.

- Files become inspectable settlements. At close range their symbol composition
  reveals responsibility-local groups, shared declarations, and unknown scope.
- Shared primitives are commons; composition roots are junctions. Neither is
  automatically a defect. Mixed ownership and insufficient evidence stay distinct.
- Districts need not tile the island. Preserve empty land, disconnected membership,
  and unassigned infrastructure. Do not force every file into an exclusive district.
- Zoom reveals the place under the cursor, progressively. Selecting an alternative
  changes the arrangement under consideration; ordinary zoom does not.
- Motion explains composition and transitions. It is not agent activity or history.
- An optional alternatives view hints at available investigations before a move is
  selected. Specific resistance belongs to a specific scenario: required companions,
  shared private dependencies, reverse dependencies, cycle costs, and preservations.
- Tracing paper keeps the current arrangement visible beneath a proposed one.
  Compare actual alternatives and their separate costs; never invent a winner.
- Exact destinations remain unspecified when the analyzer only establishes scope.
  A blocked modeled move is not proof that no refactoring is possible.
- The journey is island, district, file, composition, alternative, evidence.
  The map stays quiet; the margin carries explanations and accessible navigation.

## Delivery sequence

| Step | Outcome                                                                                  | Verification                                                                                     | State                                                     |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1    | Load V13.3 composition independently of map startup; inspect one file's groups and roles | Exact symbol coverage, unknown scopes preserved, package identity and survey checks              | Implemented                                               |
| 2    | Inspect V13.4 scenarios and V13.5 comparisons, including preservation and blockers       | Canonical scenario IDs and effects; current baseline retained; no synthetic recommendations      | File and relationship inspection implemented              |
| 3    | Reveal composition in local map detail with bounded motion                               | No geography mutation; deterministic arrangement; reduced motion and local zoom                  | Implemented and browser-verified                          |
| 4    | Preview one alternative on tracing paper with current arrangement underneath             | Exact affected subjects, scope-only destinations labeled, independent preview progress           | Implemented and browser-verified                          |
| 5    | Compute settlement layout independently of coastlines                                    | Repeatable inputs, collision checks, mixed scopes and detached members retained                  | Per-file and island-wide district experiments implemented |
| 6    | Fit settlements into existing geography                                                  | Coast containment, clearance, capacity, spatial stability evaluated separately from architecture | Implemented; containment and browser journey verified     |

Each step must leave a usable path through the existing atlas. Do not load all
packages' detailed reports into the browser. No semantic-tooling edits or source
rewrites are part of this effort.

## Experiments and open decisions

- Compare composition arrangements on a mixed file before choosing a rigid hierarchy.
  A display hierarchy must not imply the responsibility graph is a tree.
- Choose district boundary treatment from actual membership; do not begin with
  an exclusive Voronoi partition or fill empty space for appearance.
- Establish stable placement identities separately from membership-hashed region IDs.
- Keep visual packing pressure separate from architectural resistance.
- Preserve existing density-derived elevation until a new meaning is explicitly chosen.
- Future agent travel and historical playback need real event data and remain separate.

## Validation limits

Verification used headless Chrome, including 1440px desktop, 768px tablet, and
390px mobile widths. It does not establish Safari behavior or guarantee temporal
stability after arbitrary source changes. Computer Use was not required.

## Progress

- Existing foundation consumes V13.0–V13.2 and highlights responsibility members,
  unresolved affinities, and selected imports without moving files.
- V13.3–V13.5 are available in the library; the work below consumes their public
  reports rather than reimplementing analysis in Atlas.
- Select an island, then Responsibilities, then Inspect composition and alternatives.
  The new `/atlas-architecture/<package>.json` resource loads only on this action.
  Select a source module in the margin or a file on the map. Context files remain
  explicitly without classified source declarations.
- Composition groups use served responsibility or scope, with exact symbol IDs,
  roles, private/exported distinction, and scope-evidence completeness. Selecting a
  group traces up to 24 mapped consumers, including mediated consumption.
- Review families retain baselines, distinguish split sizes, and expose individual
  measured/conditional/unresolved effects. Preservation assertions and family
  preservation requirements are separate; missing requirements are explicit.
- Close zoom reveals a bounded local composition drawing. Cursor-directed zoom
  is enabled. A tracing slider interpolates outlined copies of affected declarations
  and required companions, retaining the current drawing and marking closure blockers.
  It is an illustrative decomposition study, not a source move or exact target.
- Independent layout uses ordered scope groups with declaration spacing. A separate
  coast-aware pass chooses nearby free sites, respects holes and existing files,
  and reserves current marks when fitting proposed marks. Unplaced identities remain
  in the margin with a display-capacity explanation. Coast clipping remains a drawing
  guard, not a substitute for the final-position containment checks.
- The first generated set contains 26 available architecture resources and 3,073
  scenarios. UI/Studio resources are approximately 18 MB each uncompressed; together
  all packages are about 70 MB. No overview prefetch is added. These are measurements
  of this build, not permanent dataset sizes.
- The largest mapped UI/Studio files in that set had 88/59 declarations; local
  fitting placed all of them in approximately 17/14 ms in a Bun process. This is
  not browser performance proof.

## Experiment decisions

- Rows remains the default; Compact clusters remains an explicit drawing alternative.
  Both were inspected over the same nine-declaration, two-group UI file.
- District grouping remains opt-in. No exclusive borders are added; empty land and
  detached components remain visible. Changing settlements does not regenerate coasts.
- Route comparisons use only the supplied redirect, surface, and collapse endpoints.
  Other scenarios retain composition studies and measured evidence, not invented routes.
- A real documentation-source revision comparison changed the source fingerprint from
  `10eb4cd4b7fe0b89` to `d3351502a33373a7`. Both reports had 71 analyzed modules and
  seven regions. All 57 mapped settlements retained their positions; none exceeded
  capacity. Fourteen modules remained outside the older geographic survey in both.
  This fixed-canvas sample supplements the membership-removal experiment. It does not
  establish stability when a new survey regenerates the geography itself.

The latest verification record is below. Earlier code-only checks established
preservation and variant labeling before rendered inspection became available.
Earlier port-4321 checks ran inside the network sandbox and did not establish
whether the user's server was offline. Later HTTP verification used an isolated
dev server on port 4322 outside that sandbox.

### Relationship and arrangement continuation

- Architecture inspection now includes a district-relationship selector. Selecting
  one frames both districts; selecting another file restores file composition.
- Current affected-consumer connections remain teal beneath amber proposed routes.
  Exact redirect/provider targets use mapped files. Proposed responsibility surfaces
  use open scope endpoints, not fictional destination modules. No disappearance is
  inferred from an edge count; baseline connections remain available.
- Route ink is capped at 64 connections per layer, with full mapped counts and
  missing proposed endpoints disclosed. Preserving the current arrangement restores
  the existing relationship overlay rather than clearing its connections.
- Rows and Compact clusters are deterministic layout experiments. Switching changes
  only drawing coordinates and resets tracing progress; symbol membership and
  architectural interpretation remain unchanged. Pairwise spacing is tested for both.

### District and declaration navigation

- An explicit responsibility-settlement toggle changes island interiors only.
  Membership planning does not read coast geometry. A separate fitter respects land
  components, holes, shoreline clearance, and settlement spacing. It never feeds
  positions into coastlines, elevation, or ocean generation.
- Placement seeds use file identity, not membership-hashed region IDs. Unassigned
  files remain separate; capacity failures remain inspectable in the index.
  Commons, junctions, mixed scopes, and unknown scopes have distinct marks, not grades.
- District selection frames mapped members. File selection retains canonical identity
  while navigation, labels, hit testing, and composition use displayed coordinates.
  Switching back to Files clears district filtering.
- Individual declarations are selectable from map marks and keyboard-accessible
  names. Current and tracing-paper copies resolve to the same symbol identity.
  Close-zoom reveal shares its interpolation with hit testing.
- A local UI/Studio fit placed 994/834 files with no capacity failures in roughly
  24/32 ms. Removing one member from a largest district left 968/810 positions
  unchanged; maximum displacement was 12.6/45.5 map units. This synthetic perturbation
  is not proof of stability across real surveys or browser performance.
- Code review caught and confirmed fixes for canonical-versus-displayed group IDs
  and district framing clearing its selection. Browser navigation later verified both.
- The generated 26-package set fits all 3,111 settlements with no capacity failures.
  Every displayed position passes land containment and 1.9-unit shore clearance;
  original coastline references are retained. This check does not establish visual quality.

### Coast-safe composition motion

- Final containment alone missed seven water-crossing paths in an 834-path sample
  of reveal and trace transitions from large UI/Studio files.
- Spatial unfolding now requires a land-contained disk enclosing the swept positions
  and mark footprint. This conservative check runs when composition changes. Unsafe
  paths fade at their fitted positions instead of crossing water or inventing a route.
  Tracing copies use the same rule, retaining the original marks beneath them.
- Reduced-motion preference uses fitted positions and opacity throughout reveal and
  tracing. Preference changes update the drawing; hit testing shares its frame math.
- A follow-up reveal sample checked 767 declarations at 19 intermediate positions.
  718 unfold spatially, 49 fade, and none cross water. Hole, enclosed-hole, hidden
  trace, and reduced-motion hit-target regressions are covered by tests. This remains
  geometry evidence, not rendered visual verification.

### Scenario reachability

- The later generated set contains 3,120 scenarios across all 14 scenario kinds.
  Eight were unreachable because newly analyzed files had no identity in the older
  map survey. Dataset counts change as this app changes.
- Source modules without map identities are now selectable, marked `not on map`.
  Their declarations and all module-scoped scenarios render in the margin, including
  preservation baselines, effects, required companions, and blockers. They do not
  receive coordinates or a tracing slider. Selecting a mapped file restores map inspection.
- Server-rendered regression coverage checks declaration names and every scenario
  ID with an empty file-identity map. Browser checks also select an unmapped module
  and restore mapped inspection without creating tracing coordinates.
- All scenario kinds have an evidence inspection path. Proposed route geometry is
  supported only for the contract's redirect, surface, and collapse endpoints.
  Symbol movement and splits retain illustrative composition studies with deferred
  exact destinations. No missing routes are inferred from before/after counts.

## Completion audit

### Visual hierarchy revision

User review rejected the first presentation as noisy and wordy. The following
revision addressed the design rather than treating that feedback as a testing gap.

- District labels retire as file marks appear. File marks and neighboring names
  retire as the selected file's composition appears. A shared detail policy controls
  drawing and hit testing; hidden files are not clickable through declaration detail.
- Package/file routes and declaration-consumer routes are opt-in. Responsibility
  selection alone no longer draws every dependency. Explicit relationship and
  alternative studies retain their route evidence.
- Map keys, drawing explanations, declaration lists, and comparisons start collapsed.
  Required companion and blocker counts remain visible when inspecting a scenario.
- Tests exercise production label selection, route opt-in, replacement-layer weights,
  and declaration hit coordinates at the revised scales. Rendered inspection then
  exposed and corrected zoom reachability, excess labels, and mobile column layout.

Evidence loading regression: both clients encoded `@` as `%40`, but the generated
Astro route used literal `@`. The encoded request returned 404; the literal route
returned 200. Both clients now share URL construction that preserves the scope
marker. A regression test compares requests against all generated route parameters.
Live checks passed for both evidence layers in UI, Studio, and Agents. These HTTP
checks do not establish browser interaction or visual quality.

| Requirement                                           | Verification                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preserve geography and separate planning from fitting | Original coast references retained; 3,111 settlements across 26 packages fit with shoreline clearance and no capacity failures                                                                   |
| Exact declarations and roles                          | Canonical grouping coverage; rendered role marks; missing-map evidence remains accessible without fabricated positions                                                                           |
| Island, district, file, declaration navigation        | Keyboard island selection; district fitting; clicking a rendered declaration; consumer trace toggle; mapped/unmapped selection; keyboard reset                                                   |
| Progressive detail and motion                         | Viewport-scaled file focus; intermediate reveal capture; mobile resize retains declarations; reduced-motion canvas snapshots are byte-identical                                                  |
| Alternatives and preservation                         | Rows and clusters; tracing at 0%, 50%, and 100%; keyboard slider; direct redirect, responsibility-surface, and collapse previews; family-scoped review lookup                                    |
| Determinism and capacity                              | Whole-island tests, all-package containment, synthetic membership change, and real source-revision comparison                                                                                    |
| Loading and recovery                                  | No architecture requests at overview; UI evidence ready in about 0.9 seconds on the warm local server; injected 503 retry and stale-survey recovery; no client exceptions on the completed paths |

Headless Chrome review reached the overview, UI island, architectural evidence,
and a mapped source module without client exceptions. The narrow-screen page had
no horizontal overflow, but its inspector incorrectly occupied half the available
width. File focus also retained too many neighboring names. The revision makes
the mobile inspector full-width and suppresses neighboring names while the selected
file remains in view. Panning elsewhere restores local names.
Confirmation captures show the focused name alone and the full-width mobile
inspector, with no horizontal overflow or client exceptions on that path.
Island arrival now reveals district names at 0.8–1.2 pixels per map unit. File focus
uses 10 pixels per unit, independent of viewport size; zoom can reach 24. The former
fixed zoom cap could prevent declaration detail entirely on smaller screens.

Relationship studies label their evidence, not every file. A screen-area budget limits
ordinary names; selected composition names sit above their marks. Panning away from
the selected file restores the local file layer. Changing to a relationship clears
the old file selection and footer context.

Scenario IDs are not globally unique in the generated reports. Selection and review
lookup use the family identity plus scenario ID. This preserves distinct alternatives
sharing an ID across files without renaming evidence or changing semantic tooling.

## Delivery verification

The subsequent [map-first revision](codebase-atlas-map-first.md) replaces the
sidebar-driven navigation described above. Belonging now appears on arrival;
projected regions and direct selection lead, with evidence in an optional drawer.
It preserves the V13 composition and alternatives underneath that interaction.

The six V13 delivery steps are implemented and the scoped browser journeys pass.
The geography, ocean, and semantic-tooling package remain unchanged.

- 84 tests pass through `bun run --cwd=apps/documentation test --maxWorkers=2`.
  Fully parallel runs hit the ocean fixture's five-second timeout under contention;
  the two-worker run preserves every assertion and timeout.
- Typecheck, lint on changed TypeScript, formatting, and the static build pass.
- Built evidence validates 3,124 scenarios across 26 packages and all 14 kinds. Family-scoped
  lookups resolve every alternative and its review without conflating reused IDs.
- Headless Chrome verifies navigation, declaration hits, consumer tracing, alternative
  controls, responsive detail, reduced motion, retry recovery, stale surveys, unmapped
  evidence, empty search, and keyboard reset. Completed paths report no client exceptions.
- Build warnings remain for the large client chunk, missing docs 404 entry, and unset
  sitemap site. Cross-browser certification, new district borders, agent activity,
  and temporal guarantees are outside this delivery.
