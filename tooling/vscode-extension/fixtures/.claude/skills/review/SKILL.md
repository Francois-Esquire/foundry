---
name: review
description: Review a change. Frontmatter is YAML, so /review here stays plain.
---

# Review

Run /code-review on @src/auth, then ask @"reviewer (agent)" for a second pass.

Arguments: $ARGUMENTS, $0, and $focus.
Branch: !`git branch --show-current`.
House style lives in ${CLAUDE_SKILL_DIR}/refs/style.md.

Code spans like `/not-a-skill` and links like [docs](/docs/review) stay plain.

```sh
/fenced @code stays plain
```
