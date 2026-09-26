---
title: Models
description: The agent roles the documentation uses and the model each one runs on.
---

The pages on this site name agents by role, not by model id. This page is the
one place a role is paired with a model. When a model changes, change it here;
a test checks the ids below against the provider tables in the code, and the
samples that copy an id against this page.

## What each provider serves

`model` is an id the provider serves. Claude Code takes an alias; Codex takes
the model id.

| Provider | Ids |
| --- | --- |
| Claude Code | `sonnet`, `opus`, `haiku`, `fable` |
| Codex | `gpt-5.5` |

## Roles

| Role | Job | Claude Code | Codex |
| --- | --- | --- | --- |
| reviewer | Reads code and reports findings without editing. | `sonnet` | `gpt-5.5` |
| implementer | Makes the requested change and commits it. | `opus` | `gpt-5.5` |
| drafter | Writes a first draft of a page or message. | `sonnet` | `gpt-5.5` |
| editor | Studies an approved corpus and proposes voice notes. | `sonnet` | `gpt-5.5` |
| critic | Critiques a proposal against recorded decisions. | `sonnet` | `gpt-5.5` |
| assessor | Judges whether an external change matters to a workspace. | `sonnet` | `gpt-5.5` |
| caretaker | Investigates drift between instructions and recent history. | `sonnet` | `gpt-5.5` |
| correspondent | Drafts replies from a correspondence history. | `sonnet` | `gpt-5.5` |
| reader | Reads fragments and suggests connections. | `haiku` | `gpt-5.5` |
| guide | Explains a workspace and asks before proposing changes. | `haiku` | `gpt-5.5` |

## Using a role

Pick the column for the provider the agent runs on and copy the id:

```ts
import { agent } from "@foundry/quirks";

const reviewer = agent({ prompt: "Review without editing.", model: "sonnet" });
const implementer = agent({
  prompt: "Implement the task. Commit when done.",
  provider: "codex",
  model: "gpt-5.5",
});
```

Omitting `model` lets the provider choose its default, which is the right call
for most steps. Name a model when the role needs a specific one.
