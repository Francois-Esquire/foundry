import { defineConfig } from "blume";

export default defineConfig({
  content: {
    include: [
      "marbles/**/*.md",
      "marbles/**/*.mdx",
      "atlas/**/*.md",
      "atlas/**/*.mdx",
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
      { label: "Atlas", path: "/atlas" },
    ],
  },
  redirects: [
    {
      from: "/marbles/use-cases/persistent-reviewer",
      to: "/marbles/use-cases/software-factory/verify#keep-review-history",
    },
    {
      from: "/marbles/use-cases/repository-caretaker",
      to: "/marbles/use-cases/software-factory/maintenance#watch-repository-instructions",
    },
    {
      from: "/marbles/use-cases/release-watcher",
      to: "/marbles/use-cases/software-factory/maintenance#watch-upstream-releases",
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
      to: "/marbles/use-cases/software-factory/maintenance#watch-repository-instructions",
    },
    {
      from: "/marbles/recipes/persistent-reviewer",
      to: "/marbles/use-cases/software-factory/verify#keep-review-history",
    },
    {
      from: "/marbles/recipes/release-watcher",
      to: "/marbles/use-cases/software-factory/maintenance#watch-upstream-releases",
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
