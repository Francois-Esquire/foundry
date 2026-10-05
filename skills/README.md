# Foundry skills

Project skills for coding agents, laid out for the
[skills CLI](https://github.com/vercel-labs/skills): one folder per skill with
a `SKILL.md` at its root.

| Skill | What it does |
| --- | --- |
| [`marbles-config`](./marbles-config/SKILL.md) | Write or change a `marbles.config.ts` against the current `@foundry/marbles` API. |

Install one into a project:

```sh
npx skills add Francois-Esquire/foundry --skill marbles-config
```

The CLI links the skill into the agent directories it manages (`.agents/skills`,
`.claude/skills`, and so on; `--copy` copies instead) and records it in that
project's `skills-lock.json`.
This repository's own `.agents/skills` holds skills installed *from* elsewhere;
the skills published *by* this repository live here.

A skill is self-contained: its references duplicate what the maintainer notes
under `docs/marbles/` say, because an installed copy cannot read this repository.
When the API doc changes, the skill changes in the same commit.
