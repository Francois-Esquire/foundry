# V13 — Package Architecture Intelligence

## Purpose

V13 takes the architectural intelligence developed across the earlier workspace-level work and turns it inward.

The focus is no longer primarily:

```text
package ↔ package
```

Instead, V13 asks:

```text
inside one package

module ↔ module
symbol ↔ symbol
concept ↔ behavior
primitive ↔ consumers
directory ↔ subsystem
```

The goal is to understand the internal architecture of a package deeply enough to simplify its wiring, improve locality, establish predictable conventions, and make future human and agentic coding structurally cleaner.

---

# North Star

> **Can Foundry understand the internal architecture of a package deeply enough to explain where responsibilities naturally belong, establish predictable hierarchical conventions, detect unnecessary wiring and misplaced primitives, and simulate simpler internal arrangements without flattening meaningful boundaries?**

Short form:

> **Make the inside of a package as understandable as we made the workspace.**

---

# The Missing Architectural Layer

A workspace can have excellent package boundaries while individual packages remain internally difficult to understand.

For example:

```text
@foundry/studio

src/
├── canvas/
├── chat/
├── roadmap/
├── tasks/
├── workspace/
├── models/
├── hooks/
├── utils/
└── index.ts
```

The package itself may contain:

```text
large internal dependency graphs
cross-directory wiring
misplaced primitives
mixed-responsibility modules
unnecessary indirection
broad utility modules
poorly localized constants
widely shared types
barrel-mediated relationships
internal cycles
bridge modules
```

V13 makes this internal structure a first-class architectural system.

---

# Core Principle — Architectural Locality

The central principle is:

> **Place a thing at the narrowest architectural scope that truthfully owns all of its meaningful consumers.**

This is deliberately different from conventions such as:

```text
all constants → constants/
all types → types/
all helpers → utils/
```

Those patterns frequently create architectural junk drawers.

Instead:

```text
one module uses it
    ↓
keep it local

multiple modules in one feature use it
    ↓
feature-local primitive

multiple features in one subsystem use it
    ↓
subsystem primitive

multiple independent subsystems use it
    ↓
package-level primitive
```

Sharing should rise only as high as necessary.

---

# Hierarchical Architecture

A healthy internal hierarchy may look conceptually like:

```text
package
│
├── subsystem
│   │
│   ├── feature
│   │   │
│   │   ├── behavior
│   │   ├── types
│   │   ├── constants
│   │   └── implementation
│   │
│   └── subsystem-level primitives
│
└── package-level primitives
```

The exact directory structure is not prescribed.

The important idea is:

> **architectural scope determines placement.**

---

# Sharing Is Evidence, Not a Destination

A recurring mistake in codebases is:

```text
used by two things
    ↓
shared/
```

V13 should explicitly resist this.

If:

```text
canvas/a.ts
canvas/b.ts
canvas/c.ts
```

all use something, that usually means:

```text
shared within Canvas
```

not:

```text
shared across the entire package
```

Therefore:

> **Sharing tells us something has multiple consumers. It does not tell us where the thing belongs.**

---

# Symbol Gravity

Package-level dependency gravity already proved useful.

V13 applies the same idea inside the package.

For each symbol, we want to understand:

```text
where it is declared
where it is consumed
how frequently it is consumed
which modules dominate its usage
which directory/subsystem dominates its usage
which concepts it participates in
where governing behavior exists
what changes with it historically
```

Conceptually:

```text
SymbolGravity {
  declarationModule

  consumingModules
  references

  dominantDirectory
  dominantConcept
  dominantBehaviorRegion

  localityDepth

  consumerSpread
  concentration

  coChangeNeighborhood
}
```

Example:

```text
MAX_RETRY_COUNT

declared
  src/constants.ts

usage
  runtime/recovery.ts   11
  runtime/provider.ts    6
  runtime/session.ts     3

everything else
  0
```

Its observed architectural gravity is:

```text
runtime/
```

The question becomes:

> Why is this package-level constant when its entire meaningful world is Runtime?

---

# Locality Shapes

Symbols can begin to exhibit descriptive locality shapes.

Examples:

```text
well-centered

over-promoted

over-localized

cross-wired

mixed-locality

distributed

bridge primitive
```

These are architectural descriptions.

They are not quality scores.

---

# Module Gravity

Modules also have internal architectural roles.

Examples:

```text
leaf
hub
aggregator
bridge
satellite
implementation
primitive holder
behavior center
mixed-responsibility
```

For example:

```text
canvas/index.ts

fan-in    47
fan-out   18
role      aggregator
```

is architecturally very different from:

```text
canvas/runtime-registry.ts

fan-in    31
fan-out    4
role      internal behavior
concept   RuntimeRegistry
```

Connectivity alone is insufficient.

The role of that connectivity matters.

---

# Internal Architectural Seams

Directories and subsystems often behave like miniature package boundaries.

Example:

```text
canvas/
   ↓
models/
   ↓
tasks/
```

V13 should measure relationships across these seams:

```text
module edges
symbol flow
concept flow
behavior flow
history coupling
```

This lets us ask questions such as:

> Why does Canvas depend on 38 symbols from Tasks?

Possible explanations could include:

```text
healthy collaboration

one misplaced primitive

missing abstraction

unnecessary wiring bridge

two directories that are actually one subsystem

a barrel hiding the real relationship
```

V13 should expose these possibilities before deciding anything should move.

---

# Internal Rewiring Opportunities

The eventual goal is to identify plausible simplifications.

Initially these remain analysis and simulation.

## Move Closer

```text
Symbol X

declared
  common/utils.ts

usage
  canvas/* 96%

candidate locality
  canvas/
```

---

## Promote Upward

```text
Type X

used independently by
  canvas/
  roadmap/
  tasks/
```

The nearest truthful scope may be package-level.

---

## Demote Downward

```text
Constant X

currently package-wide

actual consumers
  roadmap/editor/*
```

Potential:

```text
move into roadmap/editor scope
```

---

## Split Mixed Module

```text
utils.ts

contains
  canvas helpers
  task helpers
  generic string helper
```

Usage neighborhoods may reveal several unrelated responsibilities.

Potential:

```text
split by architectural locality
```

---

## Collapse Wiring

```text
A
↓
helper
↓
B
```

where the helper:

```text
has one consumer
has no independent concept
has no independent behavior
adds no meaningful boundary
```

Potential:

```text
remove unnecessary indirection
```

---

## Introduce Internal Primitive

Repeated:

```text
literal
type shape
constant
identifier form
small contract
```

appears repeatedly inside one architectural region.

Potential:

```text
formalize a local primitive
```

---

# Primitive Intelligence

V13 should identify recurring structural roles such as:

```text
type
constant
identifier
schema
contract
factory
configuration
adapter
implementation
utility primitive
representation
behavior
aggregator
```

But placement should never derive from role alone.

The model is:

```text
ROLE
+
ARCHITECTURAL LOCALITY
=
PLACEMENT CONTEXT
```

For example:

```text
CanvasNodeId

role
  primitive

scope
  Canvas subsystem
```

versus:

```text
WorkspaceId

role
  primitive

scope
  package-wide
```

versus:

```text
DEFAULT_CANVAS_SCALE

role
  constant

scope
  Canvas rendering
```

This prevents:

```text
types.ts
constants.ts
utils.ts
```

from becoming universal dumping grounds.

---

# Lowest Common Architectural Scope

A useful deterministic primitive for V13 is the idea of a lowest common scope.

Given:

```text
canvas/editor/a.ts
canvas/editor/b.ts
canvas/tools/c.ts
```

the filesystem common ancestor is:

```text
canvas/
```

But V13 should ultimately reason using more than paths.

Potential evidence:

```text
directory hierarchy
dependency topology
concept membership
behavior locality
historical coupling
```

The result is an:

> **architectural common scope**

rather than merely a common directory.

This could become one of the foundations for placement intelligence.

---

# Internal Regions

V13 should eventually identify coherent internal architectural regions.

Examples could include:

```text
Canvas
Task execution
Roadmap editing
Workspace editor
Chat rendering
Model management
```

These should not be generated from arbitrary machine-learning clusters.

Regions should emerge deterministically from evidence such as:

```text
existing directory hierarchy
module dependencies
concept families
behavior
co-change
symbol flow
```

Existing explicit structure should remain strong evidence.

---

# Conventions Should Be Discovered Hierarchically

The objective is not to impose one universal code organization scheme.

Instead Foundry should be able to observe:

```text
this package tends to colocate contracts with concepts

this subsystem keeps constants beside governing behavior

these primitives live one level above their consumers

these adapters consistently sit at subsystem boundaries
```

This creates conventions grounded in the actual architecture.

Eventually:

```text
new thing
   ↓
identify role
   ↓
identify concept
   ↓
identify architectural scope
   ↓
find existing convention
   ↓
suggest predictable placement
```

---

# Agentic Coding Payoff

Agents frequently have enough information to write correct code but not enough architectural context to place it correctly.

Typical uncertainty:

```text
Where should this type go?

Should this constant be global?

Should this helper be shared?

Should I introduce another file?

Should I import through this barrel?

Should this implementation sit beside its consumer?

What existing convention applies here?
```

Package Architecture Intelligence can expose:

```text
PACKAGE STRUCTURE

Canvas
  primitives
  behavior
  contracts
  implementations

Task execution
  primitives
  behavior
  representations

Package-level
  genuinely cross-subsystem contracts
```

An agent adding:

```text
CanvasViewportId
```

could reason:

```text
role
  primitive

concept
  CanvasViewport

scope
  Canvas subsystem

existing convention
  Canvas primitives are colocated here

placement
  predictable
```

This has the potential to significantly reduce architectural entropy introduced by agentic coding.

---

# V13 Roadmap

## V13.0 — Internal Package Topology

### Question

> **What architectural structure exists inside one package?**

Establish:

```text
module graph
directory/subsystem graph
internal dependency edges
symbol flow
internal seams
module fan-in/fan-out
hubs
aggregators
bridges
satellites
cycles
```

No movement recommendations yet.

This becomes the factual foundation for the Order.

---

## V13.1 — Symbol Gravity & Architectural Locality

### Question

> **Where does each symbol naturally belong based on its actual architectural neighborhood?**

Analyze:

```text
consumer locality
reference concentration
directory locality
concept locality
behavior locality
historical locality
consumer spread
nearest truthful scope
```

Begin describing locality shapes such as:

```text
well-centered
over-promoted
over-localized
cross-wired
mixed-locality
distributed
```

No mutation.

---

## V13.2 — Internal Concepts & Responsibility Regions

### Question

> **What coherent subsystems and responsibility regions exist inside the package?**

Use deterministic evidence from:

```text
concept families
module topology
symbol flow
behavior
directory structure
co-change
```

to expose meaningful internal regions.

Do not create arbitrary clusters.

---

## V13.3 — Primitive & Convention Intelligence

### Question

> **What recurring structural roles exist, and how are those roles conventionally organized at different architectural scopes?**

Identify:

```text
types
constants
identifiers
schemas
contracts
factories
configuration
adapters
implementations
utility primitives
```

Combine:

```text
role
+
locality
+
existing architecture
```

to understand predictable package conventions.

Avoid universal `types/`, `constants/`, or `shared/` rules.

---

## V13.4 — Internal Rewiring Scenarios

### Question

> **What simpler internal arrangements could exist without changing package behavior?**

Construct alternatives such as:

```text
move symbol
move module
split module
merge trivial module
redirect internal import
promote primitive
demote primitive
remove indirection
formalize subsystem boundary
```

Still analysis-only.

No source mutation.

---

## V13.5 — Package Architecture Review

### Question

> **Which internal rewiring scenarios genuinely simplify the package while preserving meaningful architectural boundaries?**

Compare alternatives using dimensions such as:

```text
dependency reduction
locality improvement
surface reduction
concept cohesion
behavior locality
historical alignment
cycle changes
module count
import depth
boundary preservation
```

No universal architecture score.

No automatic winner when real tradeoffs exist.

---

# V13 Capability Progression

```text
V13.0
SEE THE INTERNAL TOPOLOGY

        ↓

V13.1
UNDERSTAND WHERE THINGS GRAVITATE

        ↓

V13.2
UNDERSTAND INTERNAL RESPONSIBILITY REGIONS

        ↓

V13.3
UNDERSTAND PRIMITIVES AND CONVENTIONS

        ↓

V13.4
SIMULATE SIMPLER INTERNAL ARRANGEMENTS

        ↓

V13.5
COMPARE THE ARCHITECTURAL TRADEOFFS
```

---

# Relationship to Earlier Work

There is a useful symmetry:

```text
V9
workspace architecture

package ↔ package


V13
package architecture

module ↔ module
symbol ↔ symbol
```

Much of the earlier ethos carries inward:

```text
facts before interpretation

interpretation before simulation

simulation before action

dependency before chronology

one conceptual jump per version

preserve explicit intent

do not flatten meaningful boundaries

do not mistake concentration for ownership

do not mistake sharing for scope

do not mistake connectivity for importance
```

---

# Architectural Anchors Still Matter

The existing anchor concept remains important inside packages.

An internal module or region may intentionally exist as a separate fixture because of:

```text
semantic identity
system boundaries
format boundaries
future consumers
testability
representation concerns
external compatibility
```

Observed usage concentration must never automatically collapse an anchored boundary.

---

# Important Distinctions to Preserve

V13 should continue preserving distinctions developed throughout the analyzer:

```text
usage ≠ behavior

representation ≠ implementation

dependency ≠ semantic ownership

history coupling ≠ dependency

high volume ≠ architectural importance

concentration ≠ canonical ownership

shared ≠ global

directory proximity ≠ conceptual locality

role ≠ placement

current architecture ≠ intended architecture
```

---

# Non-Goals

V13 should initially avoid:

```text
source mutation
automatic file moves
universal folder conventions
LLM-based semantic clustering
embeddings
global quality scores
"clean architecture" prescriptions
automatic flattening
automatic shared/ extraction
automatic utils/ extraction
```

The objective is understanding first.

---

# Long-Term Direction

If successful, the internal architecture loop becomes:

```text
PACKAGE SOURCE
      ↓
internal topology
      ↓
symbol gravity
      ↓
responsibility regions
      ↓
primitive/convention intelligence
      ↓
rewiring scenarios
      ↓
architecture review
      ↓
future authorized mutation
```

Eventually the same intelligence can guide agentic coding before entropy is introduced:

```text
new responsibility
      ↓
what concept?
      ↓
what role?
      ↓
what locality?
      ↓
what convention?
      ↓
where does it naturally belong?
```

---

# V13 Order Definition

## Vision

A package should have an internal architecture that humans and agents can understand predictably rather than discover through trial-and-error imports.

## Requirement

Foundry can deterministically explain:

```text
how modules relate
how symbols flow
where responsibilities concentrate
where primitives naturally belong
which internal regions exist
which conventions already govern placement
where wiring is unnecessarily indirect
which alternative arrangements could simplify the package
```

without erasing intentional boundaries or mutating source.

## Completion State

V13 is complete when Foundry can take a complex package and move from:

```text
"this package contains hundreds of files"
```

to:

```text
"these are its architectural regions,
these are the responsibilities they own,
these symbols are centered correctly,
these ones are crossing architectural scopes,
these primitives belong at these levels,
these conventions already exist,
and these are the plausible ways the internal wiring could become simpler."
```

---

# Final North Star

> **Make the inside of a package as understandable as we made the workspace—so responsibilities naturally gravitate toward the places that own them, shared primitives rise only as high as necessary, internal wiring becomes predictable, and both humans and coding agents can extend the system without slowly dissolving its architecture.**
