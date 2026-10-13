---
title: The API at a glance
description: How work, resources, triggers, and callback contexts fit together.
---

A Marbles automation is an ordinary TypeScript module. Its top-level code
declares work and resources. Marbles loads those declarations into a
catalog, then runs work when you launch it or a trigger fires.

The factories combine [Foundry primitives](/marbles/foundation/primitives).
[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
provides step execution; Marbles connects the resource libraries to the
run. [Durability](/marbles/foundation/durability) describes the resulting
guarantees before the method-level details below.

## Work, resources, and triggers

| Part | API | Role |
| --- | --- | --- |
| Work | `step`, `workflow` | A step does work; a workflow connects steps through their results. |
| Resources | `agent`, `workspace`, `sandbox`, `artifact`, `skills` | Declare instructions, directories, execution environments, versioned outputs, and reusable skills. |
| Triggers | `schedule`, `monitor` | Start work on a clock or react when a source changes. |

Named steps and workflows appear in `marbles list` and the dashboard's
Marbles panel. Resource definitions support that work; they are not
independently launchable catalog entries. Schedules and monitors appear in
the Triggers panel with keys derived from their targets or sources.

## One automation, three moments

1. **Load the module.** Builders create definitions, and schedules and
   monitors register their triggers. Keep this code free of operational work.
2. **Build the workflow tree.** A workflow setup callback uses launch input
   to connect steps. Calling a step definition creates a node; it does not
   execute the step.
3. **Execute the steps.** Each step callback receives its input and the
   context it needs to do work. Children finish before the parent that
   consumes their results.

The [quickstart](/marbles/get-started/quickstart) uses just one step, so it
needs no workflow setup. Add a workflow when several steps need to compose.

## Definitions, instances, and contexts

These terms answer different questions:

- **Definition:** what has been declared, with which defaults?
- **Instance:** which operations does the returned object expose?
- **Context:** what does Marbles provide to this callback at this moment?

For example, `agent({ prompt: "Review the change." })` returns an `Agent`
with a definition and `generate`/`stream` methods. Inside a step,
`agents.session(reviewer)` opens a conversation using that definition. The
session and its turns belong to the step's run.

Read [Definitions and instances](/marbles/foundation/definitions-and-instances),
then [Contexts](/marbles/foundation/contexts) for the lifecycle behind those
calls. [Composition](/marbles/foundation/composition) connects their results.

## Package entry points

| Import | Intended use |
| --- | --- |
| `@foundry/marbles` | Author automations: builders, resource factories, triggers, helpers, and their types. |
| `@foundry/marbles/prebuilt` | Register a ready-made step with your chosen options. |
| `@foundry/marbles/lib` | Embed an engine in a separate application with explicit dependencies. |

Use the first entry for your automation modules. Embedding is an advanced
host integration described in the [engine reference](/marbles/reference/engine).
Exact options and return values live in the [API reference](/marbles/reference/api).
