import { defineConfig } from "blume";

export default defineConfig({
  content: {
    include: [
      "marbles/**/*.md",
      "marbles/**/*.mdx",
      "spyglass/**/*.md",
      "spyglass/**/*.mdx",
    ],
    root: ".",
  },
  deployment: {
    base: "/foundry",
    output: "static",
    site: "https://francois-esquire.github.io",
  },
  description: "Documentation for Foundry's local developer tools.",
  github: { dir: "docs", owner: "Francois-Esquire", repo: "foundry" },
  navigation: {
    tabs: [
      { label: "Marbles", path: "/marbles" },
      { label: "Spyglass", path: "/spyglass" },
    ],
  },
  redirects: [
    {
      from: "/marbles/use-cases/software-factory/intake",
      to: "/marbles/use-cases/software-factory/development/intake",
    },
    {
      from: "/marbles/use-cases/software-factory/work-log",
      to: "/marbles/use-cases/software-factory/development/work-log",
    },
    {
      from: "/marbles/use-cases/software-factory/plan",
      to: "/marbles/use-cases/software-factory/development/plan",
    },
    {
      from: "/marbles/use-cases/software-factory/implement",
      to: "/marbles/use-cases/software-factory/development/implement",
    },
    {
      from: "/marbles/use-cases/software-factory/verify",
      to: "/marbles/use-cases/software-factory/development/verify",
    },
    {
      from: "/marbles/use-cases/software-factory/revise",
      to: "/marbles/use-cases/software-factory/development/revise",
    },
    {
      from: "/marbles/use-cases/software-factory/approve",
      to: "/marbles/use-cases/software-factory/development/approve",
    },
    {
      from: "/marbles/use-cases/software-factory/pull-requests",
      to: "/marbles/use-cases/software-factory/maintenance/pull-requests",
    },
    {
      from: "/marbles/use-cases/software-factory/on-call",
      to: "/marbles/use-cases/software-factory/maintenance/on-call",
    },
    {
      from: "/marbles/use-cases/software-factory/maintenance",
      to: "/marbles/use-cases/software-factory/maintenance/signals",
    },
    {
      from: "/marbles/use-cases/software-factory/automate",
      to: "/marbles/use-cases/software-factory/maintenance/automate",
    },
    {
      from: "/marbles/use-cases/software-factory/inspector",
      to: "/marbles/use-cases/software-factory/improvement/inspector",
    },
    {
      from: "/marbles/use-cases/software-factory/factory-floor",
      to: "/marbles/use-cases/software-factory",
    },
    {
      from: "/marbles/use-cases/persistent-reviewer",
      to: "/marbles/use-cases/software-factory/development/verify#keep-review-history",
    },
    {
      from: "/marbles/use-cases/repository-caretaker",
      to: "/marbles/use-cases/software-factory/maintenance/signals#watch-repository-instructions",
    },
    {
      from: "/marbles/use-cases/release-watcher",
      to: "/marbles/use-cases/software-factory/maintenance/signals#watch-upstream-releases",
    },
    { from: "/marbles/start-here", to: "/marbles/get-started/quickstart" },
    {
      from: "/marbles/concepts/automation-as-code",
      to: "/marbles/foundation/definitions-and-instances",
    },
    {
      from: "/marbles/concepts/composition",
      to: "/marbles/foundation/composition",
    },
    {
      from: "/marbles/concepts/agents-and-sessions",
      to: "/marbles/foundation/agents-and-sessions",
    },
    {
      from: "/marbles/concepts/schedules-and-monitors",
      to: "/marbles/foundation/triggers",
    },
    {
      from: "/marbles/concepts/execution-and-state",
      to: "/marbles/foundation/execution-and-state",
    },
    { from: "/marbles/concepts", to: "/marbles/foundation/api" },
    {
      from: "/marbles/guides/software-factory",
      to: "/marbles/use-cases/software-factory",
    },
    {
      from: "/marbles/reference/configuration",
      to: "/marbles/reference/project",
    },
    { from: "/marbles/safety-and-limits", to: "/marbles/reference/safety" },
    {
      from: "/marbles/recipes",
      to: "/marbles/get-started/using-marbles#choose-a-use-case",
    },
    {
      from: "/marbles/recipes/repository-caretaker",
      to: "/marbles/use-cases/software-factory/maintenance/signals#watch-repository-instructions",
    },
    {
      from: "/marbles/recipes/persistent-reviewer",
      to: "/marbles/use-cases/software-factory/development/verify#keep-review-history",
    },
    {
      from: "/marbles/recipes/release-watcher",
      to: "/marbles/use-cases/software-factory/maintenance/signals#watch-upstream-releases",
    },
    {
      from: "/marbles/recipes/design-sync",
      to: "/marbles/use-cases/design-sync",
    },
  ],
  theme: {
    accent: "gray", // a named preset or any CSS color
    fonts: {
      body: "inter",
      // self-hosted Google Fonts
      display: "inter",
      mono: "ibm-plex-mono",
    },
    mode: "system", // system | light | dark
    radius: "md", // none | sm | md | lg
  },
  title: "Foundry",
});
