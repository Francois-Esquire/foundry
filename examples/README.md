# Examples

Small programs built on Foundry's published packages. Each one is a workspace
package of its own under `examples/`, depends on what it shows with
`workspace:*`, and imports it by its published name, as a project outside
this repository would.

| Example | Shows |
| --- | --- |
| [Foundry Agent Harness](./foundry-agent-harness/README.md) | Marbles as a library: agents, tasks, and artifacts behind a terminal UI in OpenTUI and TermCN. |

## Add an example

Create `examples/<name>/` with a `package.json`, a `tsconfig.json`, and a
`README.md`. Give it a `start` script that runs it and a `typecheck` script.
Keep it to the code the example is about.

An example with a terminal UI uses OpenTUI and takes its components from
[TermCN](https://www.termcn.dev) through the shadcn CLI. Biome and Knip skip
`src/components/ui`, `src/hooks`, and `src/lib/terminal-themes` in every
example, since that code is copied in.
