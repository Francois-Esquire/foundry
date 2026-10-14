---
title: Brief and wireframes
description: Establish the product task and information order before refining the visual design.
---

Write the brief before asking an agent for screens. Name who will use the
product, what they need to accomplish, and what currently gets in their way.
Include representative content, platform constraints, and design references
that should remain recognizable.

## Work through the journey

Map the entry point, the decisions the person must make, the action they take,
and how they know it worked. Include empty, loading, error, permission, and
recovery states where the task requires them. Resolve missing product rules
with the owner instead of letting a layout invent them.

An agent can propose wireframes and alternatives. Ask it to explain the
content order and the purpose of each control. Keep early wireframes plain
enough that the review stays about the task. A polished screen can hide an
unresolved flow.

## Make a local prototype

The existing `prototype` step can draft self-contained HTML and CSS from a
brief. This complete module registers it:

```ts
import { prototype } from "@foundry/marbles/prebuilt";

prototype({ name: "design-wireframe" });
```

Save it as `.foundry/marbles/wireframe.ts`, then run:

```sh
marbles roll design-wireframe --input '{"brief":"Wireframe a support queue for an on-call engineer. Show ownership, severity, and time waiting. Include empty and loading states. Keep the current product navigation. Explain the information order."}'
```

The step requires an authenticated CLI provider. Its result is text; it does
not save a page, open a browser, or verify the interface. Save a reviewed
prototype in your project, run it locally, and inspect the journey yourself.
Use the project's browser tooling when available.

## Record the choice

Store the selected flow and its unresolved questions in the design record.
Keep rejected alternatives with a short reason when the decision is likely
to be revisited. A person approves the direction before visual refinement.

Next: [Adjust the design](/marbles/use-cases/design/iterate).
