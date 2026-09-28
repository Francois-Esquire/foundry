---
title: Configuration
description: The semantics section of foundry.config.json, and what else Atlas reads from a workspace.
---

Atlas takes its runtime settings from the command line. What it reads from
the workspace is one optional file, `foundry.config.json` at the root, under
the `semantics` key:

```json
{
  "semantics": {
    "roots": ["apps", "packages", "plugins", "tooling"],
    "exclude": [],
    "history": {
      "checkpoints": 12,
      "every": 100,
      "range": "1y",
      "strategy": "monthly"
    }
  }
}
```

Those are the defaults. A missing file means defaults. The file is not
validated: unknown keys are ignored, and a file that is not valid JSON fails
the scan.

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `roots` | `string[]` | `["apps", "packages", "plugins", "tooling"]` | Directories whose immediate children are candidate units. A root that does not exist is recorded in the manifest as missing. |
| `exclude` | `string[]` | `[]` | Root-relative unit directories to skip, such as `packages/fixtures`. The manifest lists them with the reason `excluded`. |
| `history.checkpoints` | number | `12` | Upper bound on checkpoints per `--history` scan. `HEAD` always counts. |
| `history.every` | number | `100` | Commit stride for the `every-n-commits` strategy. |
| `history.range` | string | `"1y"` | How far back from `HEAD`: `<n>y`, `<n>m`, `<n>d`, or `all`. Anything else fails the history scan. |
| `history.strategy` | string | `"monthly"` | `monthly`, `evenly-spaced`, or `every-n-commits`. |

`semantics.output` exists for the library and is ignored by the CLI, which
always writes under the state root.

## What else Atlas reads

- The root `package.json`: `workspaces`, as an array or `{ "packages": [] }`,
  and `name`.
- Each unit's `package.json`: `name`, `exports`, `main`, `module`, and
  `private`, to decide what the package exposes.
- Each unit's `tsconfig.json`: `paths` that point inside the package, and
  `references`.
- Every `.gitignore` between the root and a file. Global excludes are not
  read.
- Git, when the directory is a repository: the full log with renames, and
  the tracked file list.

No environment variables are read.
