import { defineStories, story } from "textbook-sh";
import {
  DashboardLayout,
  type DashboardPanels,
  type DrawerDock,
  dashboardMain,
} from "~/components/layouts/dashboard";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "../frame";
import { Slot } from "./slot";

const HEIGHT = 22;

interface Arrangement {
  readonly drawer?: DrawerDock | "undocked";
  readonly panels?: boolean;
  readonly rail?: boolean;
  readonly width: number;
}

function mainLabel({ drawer, rail, width }: Arrangement) {
  const main = dashboardMain({
    drawer: drawer !== undefined,
    drawerDock: drawer === "undocked" ? undefined : drawer,
    rail: rail === true,
    width,
  });
  return `main · ${main.width} columns · ${main.wide ? "wide" : "narrow"}`;
}

function panels(arrangement: Arrangement): DashboardPanels {
  const { drawer, rail } = arrangement;
  return {
    drawer: drawer && {
      content: (
        <Slot
          detail="Workspaces, settings, or diagnostics"
          label={
            drawer === "undocked" ? "drawer · no dock" : `drawer · ${drawer}`
          }
          tone={theme.colors.primary}
        />
      ),
      dock: drawer === "undocked" ? undefined : drawer,
    },
    main: (
      <Slot
        detail="Overview, catalog, details, usage, or feed"
        label={mainLabel(arrangement)}
        tone={theme.colors.accent}
      />
    ),
    rail: rail ? (
      <Slot detail="Hosted workspaces" label="rail" tone={theme.colors.info} />
    ) : undefined,
  };
}

function Arranged(arrangement: Arrangement) {
  return (
    <DashboardLayout
      above={
        <Slot
          detail="Search, keyboard help, notices"
          grow={false}
          label="above"
        />
      }
      below={
        <Slot
          detail="Prompt, work status, footer, quit dialog"
          grow={false}
          label="below"
        />
      }
      header={
        <>
          <Slot grow={false} label="header · workspace" />
          <Slot grow={false} label="header · view tabs" />
        </>
      }
      panels={arrangement.panels === false ? undefined : panels(arrangement)}
      width={arrangement.width}
    />
  );
}

function arranged(arrangement: Arrangement) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(renderer, <Arranged {...arrangement} />, {
      height: HEIGHT,
      padded: false,
      width: arrangement.width,
    });
}

export default defineStories({
  component: "DashboardLayout",
  description:
    "The dashboard chrome: a header row, what sits above the body, the body (main, workspace rail, and drawer), and what sits below it.",
  title: "Layouts/Dashboard",
});

export const Wide = story({
  description:
    "Main alone at 120 columns; from 112 columns main counts as wide.",
  name: "Main only · wide",
  render: arranged({ width: 120 }),
});

export const Narrow = story({
  description: "Main alone at 100 columns, below the wide threshold.",
  name: "Main only · narrow",
  render: arranged({ width: 100 }),
});

export const Rail = story({
  description:
    "The workspace rail beside main at 120 columns; main narrows to 91 columns.",
  name: "With rail",
  render: arranged({ rail: true, width: 120 }),
});

export const RailWide = story({
  description:
    "The rail at 140 columns, where main still counts as wide (from 139 columns).",
  name: "With rail · wide main",
  render: arranged({ rail: true, width: 140 }),
});

export const RailHidden = story({
  description:
    "The rail is asked for at 90 columns but needs 96, so main fills the body.",
  name: "Rail hidden when narrow",
  render: arranged({ rail: true, width: 90 }),
});

export const DockedRight = story({
  description:
    "A drawer docked on the right at 120 columns; docking needs 117 columns.",
  name: "Drawer docked right",
  render: arranged({ drawer: "right", width: 120 }),
});

export const DockedLeft = story({
  description:
    "A drawer docked on the left at 120 columns, as the workspace picker docks.",
  name: "Drawer docked left",
  render: arranged({ drawer: "left", width: 120 }),
});

export const DockedWide = story({
  description:
    "A docked drawer at 160 columns, where main still counts as wide (from 159 columns).",
  name: "Drawer docked · wide main",
  render: arranged({ drawer: "right", width: 160 }),
});

export const Overlaid = story({
  description:
    "A drawer that asks to dock at 100 columns has no room, so it covers the body.",
  name: "Drawer overlaid when narrow",
  render: arranged({ drawer: "right", width: 100 }),
});

export const Undocked = story({
  description:
    "A drawer without a dock, like diagnostics, covers the body at any width.",
  name: "Drawer without dock",
  render: arranged({ drawer: "undocked", width: 140 }),
});

export const RailAndDrawer = story({
  description:
    "A rail and a docked drawer together: the drawer docks and the rail is dropped.",
  name: "Rail and drawer",
  render: arranged({ drawer: "right", rail: true, width: 140 }),
});

export const NoBody = story({
  description:
    "Without panels only the header, above, and below show, as when keyboard help is open.",
  name: "No body",
  render: arranged({ panels: false, width: 120 }),
});
