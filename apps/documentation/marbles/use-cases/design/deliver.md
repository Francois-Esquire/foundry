---
title: Build and review
description: Turn an approved design into an implementation with explicit visual and interaction evidence.
---

Approve a specific design record before implementation. The handoff should
include the brief, selected flow, component and token references, content,
responsive rules, interaction states, and unresolved questions. Reference an
artifact version or design revision so later edits cannot silently change
what was accepted.

## Make the handoff executable

Create an issue with acceptance criteria for both function and presentation.
Name the checks and the person who will inspect the result. For example,
record whether the primary task works by keyboard, what happens on failure,
and which screen sizes need review.

The implementer reads this record with the repository's conventions. Reuse
existing components and tokens when they fit. A new component library or
package is an engineering decision that needs a reason; it is not an automatic
consequence of a new design.

Use the [delivery cycle](/marbles/use-cases/software-factory) to preserve the
implementation explanation, commits, test results, and review decisions.
When implementation exposes a product constraint, return that question to
the design owner instead of inventing a new flow.

## Review the working product

Give reviewers the approved design and exact implementation revision. Inspect
the running interface, including representative data and failure states.
Compare it at the agreed viewports and check accessibility and interaction.
An approved mockup and passing unit tests do not constitute that evidence.

Keep findings tied to the original task. Separate implementation defects from
new design suggestions. Synthesize them into a scoped revision request and
review the new candidate before delivery.

## Continue after delivery

Schedule checks for changes that can invalidate the design, such as a token
library update or a changed component contract. Gather user feedback and
task failures for the next iteration. Use [evaluations](/marbles/use-cases/evaluations)
to test the instructions used by design agents when their output repeatedly
misses the same requirement.

[Keep tokens in sync](/marbles/use-cases/design/sync) provides one concrete
maintenance automation. It proposes palette changes for review; it covers
only that part of the product lifecycle.
