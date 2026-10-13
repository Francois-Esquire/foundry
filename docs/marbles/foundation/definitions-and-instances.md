---
title: Definitions and instances
description: Separate declaring work, placing it in a workflow, and executing a run.
---

The [Marbles model](/marbles/foundation/api) separates the description of
work from a run of that work. The authoring API follows the same distinction:
create a definition first, then decide how it will be used.

## Declare a step

```ts
import { step } from "@foundry/marbles";

const count = step("count-files").do(async ({ workspaces }) => {
  const files = await workspaces.current.files();
  return files.length;
});
```

`step("count-files")` creates a builder. `.do(...)` supplies the callback and
returns a `StepDefinition`, held here by `count`. Loading the module
registers that name in the catalog. The callback has not executed yet.

Other builder methods describe the work before `.do(...)`: `.input(schema)`
defines the values it accepts, `.output(schema)` describes its result, and
`.describe(text)` explains its purpose. The next page uses these contracts
to connect steps.

## Place it in a workflow or launch it

The same definition can be used in several ways:

| Expression | What happens |
| --- | --- |
| `count({})` | Creates a node ready to place in a workflow. No work executes. |
| `count({}, input)` | Creates a node carrying literal input, when the step declares an input schema. |
| `await count.run()` | Executes the definition directly and returns its result. |
| `marbles roll count-files` | Launches the registered definition through the CLI. |

A **node** is one placement of a definition in a workflow tree. Its first
argument describes the child steps whose results it needs; the second
supplies literal input. Creating a node is called **locking** a definition:
it fixes those children and inputs for that position.

A **run** begins when Marbles executes the definition or tree. Calling
`count({})` while describing a workflow does not start a run. This is what
lets you compose work before launching it.

Use explicit, unique names for launchable steps and workflows. Shared
helper definitions can live in imported modules; see the
[catalog rules](/marbles/reference/project#names-and-the-catalog) for name
inference and discovery.

## Resource instances describe something you can use

Resource factories return objects too. Some combine a declaration with
methods that use it. For example:

```ts
import { step, workspace } from "@foundry/marbles";

const project = workspace({ path: "." });

step("read-project").do(async () => {
  const files = await project.files();
  return { files: files.length };
});
```

`project` is a `WorkspaceInstance`. Its definition identifies a directory;
its `files()` method loads and reads that directory when called. The
underlying file operations come from
[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md).

The same distinction applies to other resources: an agent declaration
supplies instructions, and its methods perform model work; a sandbox
declaration supplies an environment, and its first operation starts it.
Their dedicated pages introduce the returned objects as you use them.
The [API reference](/marbles/reference/api#using-a-definition) lists the
complete methods and types.

## Keep module scope to declarations

Marbles imports automation modules even for `list`. A factory call or step
builder describes what is available; an operation such as `project.files()`
or an agent turn performs work. Put operations in step callbacks so they
happen when you launch the automation.

Inside a step, resource methods use its execution context. That is how
Marbles supplies their working directory and owns their activity. The
[Contexts](/marbles/foundation/contexts) page explains that connection after
we have a workflow to run.

Next: [Steps and workflows](/marbles/foundation/composition) connects these
nodes so one step can consume another's result.
