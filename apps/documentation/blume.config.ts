import { defineConfig } from "blume";

export default defineConfig({
  content: {
    include: [
      "marbles/**/*.md",
      "marbles/**/*.mdx",
      "prompts/**/*.md",
      "prompts/**/*.mdx",
      "spyglass/**/*.md",
      "spyglass/**/*.mdx",
    ],
    root: ".",
  },
  deployment: {
    base: "/foundry",
    site: "https://francois-esquire.github.io",
  },
  description: "Documentation for Foundry's local developer tools.",
  github: {
    dir: "apps/documentation",
    owner: "Francois-Esquire",
    repo: "foundry",
  },
  navigation: {
    tabs: [
      { label: "Marbles", path: "/marbles" },
      { label: "Spyglass", path: "/spyglass" },
      { label: "Prompts", path: "/prompts" },
    ],
  },
  redirects: [
    {
      from: "/marbles/use-cases/software-factory/work-log",
      to: "/marbles/use-cases/software-factory/intake",
    },
    {
      from: "/marbles/use-cases/software-factory/plan",
      to: "/marbles/use-cases/software-factory/build",
    },
    {
      from: "/marbles/use-cases/software-factory/implement",
      to: "/marbles/use-cases/software-factory/build",
    },
    {
      from: "/marbles/use-cases/software-factory/approve",
      to: "/marbles/use-cases/software-factory/deliver",
    },
    {
      from: "/marbles/use-cases/software-factory/pull-requests",
      to: "/marbles/use-cases/software-factory/revise",
    },
    {
      from: "/marbles/use-cases/software-factory/on-call",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/use-cases/software-factory/maintenance",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/use-cases/software-factory/automate",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/use-cases/software-factory/inspector",
      to: "/marbles/use-cases/evaluations/skills",
    },
    {
      from: "/marbles/use-cases/software-factory/factory-floor",
      to: "/marbles/use-cases/software-factory",
    },
    {
      from: "/marbles/use-cases/software-factory/monitor",
      to: "/marbles/get-started/marbles-ui",
    },
    {
      from: "/marbles/use-cases/software-factory/development/intake",
      to: "/marbles/use-cases/software-factory/intake",
    },
    {
      from: "/marbles/use-cases/software-factory/development/work-log",
      to: "/marbles/use-cases/software-factory/intake",
    },
    {
      from: "/marbles/use-cases/software-factory/development/plan",
      to: "/marbles/use-cases/software-factory/build",
    },
    {
      from: "/marbles/use-cases/software-factory/development/implement",
      to: "/marbles/use-cases/software-factory/build",
    },
    {
      from: "/marbles/use-cases/software-factory/development/verify",
      to: "/marbles/use-cases/software-factory/verify",
    },
    {
      from: "/marbles/use-cases/software-factory/development/revise",
      to: "/marbles/use-cases/software-factory/revise",
    },
    {
      from: "/marbles/use-cases/software-factory/development/approve",
      to: "/marbles/use-cases/software-factory/deliver",
    },
    {
      from: "/marbles/use-cases/software-factory/development",
      to: "/marbles/use-cases/software-factory/intake",
    },
    {
      from: "/marbles/use-cases/software-factory/maintenance/pull-requests",
      to: "/marbles/use-cases/software-factory/revise",
    },
    {
      from: "/marbles/use-cases/software-factory/maintenance/on-call",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/use-cases/software-factory/maintenance/signals",
      to: "/marbles/use-cases/docs-drift",
    },
    {
      from: "/marbles/use-cases/software-factory/maintenance/automate",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/use-cases/software-factory/improvement/inspector",
      to: "/marbles/use-cases/evaluations/skills",
    },
    {
      from: "/marbles/use-cases/software-factory/improvement/maintainability",
      to: "/marbles/use-cases/evaluations",
    },
    {
      from: "/marbles/use-cases/software-factory/improvement/agents-and-skills",
      to: "/marbles/use-cases/evaluations/skills",
    },
    {
      from: "/marbles/use-cases/software-factory/improvement/evaluate",
      to: "/marbles/use-cases/evaluations",
    },
    {
      from: "/marbles/use-cases/software-factory/improvement/adopt",
      to: "/marbles/use-cases/evaluations/skills",
    },
    {
      from: "/marbles/use-cases/software-factory/improvement",
      to: "/marbles/use-cases/evaluations",
    },
    {
      from: "/marbles/use-cases/persistent-reviewer",
      to: "/marbles/use-cases/software-factory/revise#keep-the-reviewers-memory",
    },
    {
      from: "/marbles/use-cases/repository-caretaker",
      to: "/marbles/use-cases/docs-drift",
    },
    {
      from: "/marbles/use-cases/release-watcher",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/start-here",
      to: "/marbles/get-started/quickstart",
    },
    {
      from: "/marbles/get-started/task-loop",
      to: "/marbles/get-started/outer-loop",
    },
    {
      from: "/marbles/get-started/using-marbles",
      to: "/marbles/get-started/marbles-ui",
    },
    {
      from: "/marbles/foundation",
      to: "/marbles/concepts",
    },
    {
      from: "/marbles/foundation/api",
      to: "/marbles/concepts",
    },
    {
      from: "/marbles/foundation/definitions-and-instances",
      to: "/marbles/concepts",
    },
    {
      from: "/marbles/foundation/composition",
      to: "/marbles/concepts/steps-and-workflows",
    },
    {
      from: "/marbles/foundation/contexts",
      to: "/marbles/concepts/steps-and-workflows#contexts",
    },
    {
      from: "/marbles/foundation/agents-and-sessions",
      to: "/marbles/concepts/agents-and-sessions",
    },
    {
      from: "/marbles/foundation/usage",
      to: "/marbles/concepts/usage",
    },
    {
      from: "/marbles/foundation/workspaces-and-sandboxes",
      to: "/marbles/concepts/workspaces-and-artifacts",
    },
    {
      from: "/marbles/foundation/artifacts-and-results",
      to: "/marbles/concepts/workspaces-and-artifacts#artifacts-and-the-feed",
    },
    {
      from: "/marbles/foundation/durability",
      to: "/marbles/concepts/durability",
    },
    {
      from: "/marbles/foundation/triggers",
      to: "/marbles/concepts/monitoring-and-scheduling",
    },
    {
      from: "/marbles/foundation/execution-and-state",
      to: "/marbles/concepts/durability#local-execution-and-state",
    },
    {
      from: "/marbles/foundation/primitives",
      to: "/marbles/concepts/primitives",
    },
    {
      from: "/marbles/concepts/automation-as-code",
      to: "/marbles/concepts",
    },
    {
      from: "/marbles/concepts/composition",
      to: "/marbles/concepts/steps-and-workflows",
    },
    {
      from: "/marbles/concepts/schedules-and-monitors",
      to: "/marbles/concepts/monitoring-and-scheduling",
    },
    {
      from: "/marbles/concepts/execution-and-state",
      to: "/marbles/concepts/durability#local-execution-and-state",
    },
    {
      from: "/marbles/guides/software-factory",
      to: "/marbles/use-cases/software-factory",
    },
    {
      from: "/marbles/reference/configuration",
      to: "/marbles/reference/project",
    },
    {
      from: "/marbles/safety-and-limits",
      to: "/marbles/reference/safety",
    },
    {
      from: "/marbles/recipes",
      to: "/marbles/use-cases",
    },
    {
      from: "/marbles/recipes/repository-caretaker",
      to: "/marbles/use-cases/docs-drift",
    },
    {
      from: "/marbles/recipes/persistent-reviewer",
      to: "/marbles/use-cases/software-factory/revise#keep-the-reviewers-memory",
    },
    {
      from: "/marbles/recipes/release-watcher",
      to: "/marbles/use-cases/release-patrol",
    },
    {
      from: "/marbles/recipes/design-sync",
      to: "/marbles/use-cases/design/sync",
    },
    {
      from: "/marbles/use-cases/design-sync",
      to: "/marbles/use-cases/design/sync",
    },
  ],
  theme: {
    accent: "gray",
    fonts: {
      body: "inter",
      display: "inter",
      mono: "ibm-plex-mono",
    },
    mode: "system",
    radius: "md",
  },
  title: "Foundry",
});
