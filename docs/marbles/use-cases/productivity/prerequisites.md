---
title: Connect your sources
description: Prepare Google Docs, Slack, and GitHub access in the CLI that will collect your briefing.
---

Configure the connectors in the same local directory and CLI account that
Marbles will use. A connector in a web chat or desktop app does not by itself
prove that a scheduled CLI session can use it.

## Local prerequisites

Complete [the quickstart](/marbles/get-started/quickstart). The example uses
Codex host sessions and `zod@4.4.3` for validation:

```sh
bun add zod@4.4.3
codex mcp list
```

Follow [Codex's MCP setup](https://developers.openai.com/codex/mcp/) to register
servers, complete OAuth, and inspect the available tools. Marbles opens the
host session in your automation directory. Verify the tools there, including
any project trust requirements and command permissions needed for `gh`.
This uses external MCP servers through the agent; it does not require the
future [Marbles MCP server](/marbles/roadmap).

## Google Docs MCP

You need access to the project documents you want in the briefing and an MCP
connection that can read their contents. Google's
[Docs MCP setup guide](https://developers.google.com/workspace/docs/api/guides/configure-mcp-server)
currently requires Developer Preview access, a Google Cloud project, the Docs
and Docs MCP APIs, and OAuth setup. Its endpoint is
`https://docsmcp.googleapis.com/mcp/v1`. If your team already uses another Docs
MCP server, verify its reading tools before using it here.

Use explicit document URLs to start. Reading a document gives its current
contents. It does not establish which paragraphs changed while you were away.
For that, add a connector with revision evidence or capture document snapshots
at departure and compare them later. The example labels document contents as
context unless it has evidence for a dated change.

Check access by asking the CLI to read one selected document and return its
title, a short passage, and its URL. Report delivery to Google Docs is a
separate write permission; collection only needs reading access.

## Slack MCP

You need a Slack account with access to the selected channels and an approved
MCP integration. Follow Slack's
[agent setup guide](https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/)
for the CLI connection and authentication. The endpoint is
`https://mcp.slack.com/mcp`.

The collector needs message search, channel history, thread reads, and source
links. Choose channels explicitly, then verify that the CLI can retrieve a
recent message and its thread. Include replies to older threads when a reply
falls inside the reporting window. Add private channels or direct messages
only when you intend them to be part of this personal report.

## GitHub MCP or GitHub CLI

Choose one route. Both need access to every selected repository.

| Route | Setup and verification |
| --- | --- |
| GitHub MCP | Follow the [official server guide](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md). Enable the reading tools for repositories, issues, PRs, and Actions. Read-only mode limits the exposed tools. Verify a known PR, its reviews, and its checks. |
| `gh` | Install the [GitHub CLI](https://cli.github.com/), authenticate, and run the commands below with your repository. |

```sh
gh auth status
gh repo view OWNER/REPOSITORY --json nameWithOwner,url
gh pr list --repo OWNER/REPOSITORY --state all --limit 5 --json number,title,url,updatedAt
```

The last command is an access check, not a complete activity collector.
Collection must follow pagination and inspect relevant commits, PR and issue
activity, reviews, checks, and releases. The CLI's
[`gh api --paginate`](https://cli.github.com/manual/gh_api) supports paginated
requests; each endpoint still needs the right filters.

## Verify the scheduled session

Run the briefing manually through Marbles before enabling its schedule.
Confirm actual source links and coverage, not just a successful model reply.
OAuth expiry, a missing tool, or an unanswered CLI permission prompt can leave
a source unreadable when nobody is present.

Use reading permissions for collection. The example's prompt is not a
permission system. Keep credentials in the CLI or connector's credential
store, not in the briefing profile, source code, or report. If a connector
requires environment variables, load them through
[Varlock](/marbles/reference/project#environment).

Next: [Build the morning report](/marbles/use-cases/productivity/morning-report).
