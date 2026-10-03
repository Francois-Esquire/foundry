# Sandbox network access

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

An agent in a sandbox needs to reach a few destinations, such as the model
API and a package registry, and nothing else. Today a sandbox has either no
outbound network or all of it. The workflow-level sandbox definition has no
network setting, so every workflow sandbox gets none.

- Egress is set per sandbox and defaults to none.
- An allow list names the destinations a sandbox may reach.
- What was reached or refused is recorded.
- Ideally, credentials are added outside the VM, so the agent never holds
  them.

Done means a sandbox running a coding agent can reach the model API and the
package registry, and a request anywhere else fails and is logged.

## Opinion: how to build it

- Now: expose the existing `disabled` or `unrestricted` choice on the
  workflow sandbox definition, defaulting to `disabled`. That unblocks
  agents in sandboxes today, with the risk of `unrestricted` stated plainly
  where it is chosen.
- Next: a host-side egress proxy. The VM has no direct route out; its only
  path is the proxy, which enforces a domain allow list, logs requests, and
  adds credentials such as model API keys on the way out.
- Check whether microsandbox's network policy rules can express destination
  allow lists. If they can, they are a cheaper first step than the proxy,
  though they neither log nor add credentials.
