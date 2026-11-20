import type { ReactNode } from "react";
import { theme } from "~/components/ui/theme";

const PADDING_X = 1;
const WIDE = 110;
const DRAWER_WIDTH = 46;
const DRAWER_REMAINDER = 68;
const RAIL_WIDTH = 27;
const RAIL_MIN_WIDTH = 94;

export type DrawerDock = "left" | "right";

interface DashboardRegions {
  readonly drawer: boolean;
  readonly drawerDock?: DrawerDock;
  readonly rail: boolean;
  readonly width: number;
}

interface Arrangement {
  readonly docked: boolean;
  readonly main: boolean;
  readonly mainWidth: number;
  readonly rail: boolean;
}

function arrange({
  width,
  rail,
  drawer,
  drawerDock,
}: DashboardRegions): Arrangement {
  const body = width - 2 * PADDING_X;
  const docked =
    drawer &&
    drawerDock !== undefined &&
    body >= DRAWER_WIDTH + DRAWER_REMAINDER + 1;
  const showRail = !drawer && rail && body >= RAIL_MIN_WIDTH;
  return {
    docked,
    main: !drawer || docked,
    mainWidth:
      body - (docked ? DRAWER_WIDTH + 1 : 0) - (showRail ? RAIL_WIDTH : 0),
    rail: showRail,
  };
}

export function dashboardMain(regions: DashboardRegions) {
  const { main, mainWidth } = arrange(regions);
  return { shown: main, wide: mainWidth >= WIDE, width: mainWidth };
}

interface DashboardDrawer {
  readonly content: ReactNode;
  readonly dock?: DrawerDock;
}

export interface DashboardPanels {
  readonly drawer?: DashboardDrawer;
  readonly main?: ReactNode;
  readonly rail?: ReactNode;
}

function Drawer({
  docked,
  children,
}: {
  readonly docked: boolean;
  readonly children: ReactNode;
}) {
  return (
    <box
      backgroundColor={theme.colors.background}
      flexDirection="column"
      flexShrink={0}
      minHeight={0}
      width={docked ? DRAWER_WIDTH : "100%"}
    >
      {children}
    </box>
  );
}

function DashboardBody({
  width,
  panels,
}: {
  readonly width: number;
  readonly panels: DashboardPanels;
}) {
  const { drawer, main, rail } = panels;
  const arrangement = arrange({
    drawer: drawer !== undefined,
    drawerDock: drawer?.dock,
    rail: rail !== undefined,
    width,
  });
  const { docked } = arrangement;
  if (!arrangement.main) {
    return (
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Drawer docked={false}>{drawer?.content}</Drawer>
      </box>
    );
  }
  return (
    <box flexDirection="row" flexGrow={1} gap={docked ? 1 : 0} minHeight={0}>
      {docked && drawer?.dock === "left" && (
        <Drawer docked>{drawer.content}</Drawer>
      )}
      {arrangement.rail && (
        <box
          flexDirection="column"
          flexShrink={0}
          paddingRight={1}
          width={RAIL_WIDTH}
        >
          {rail}
        </box>
      )}
      <box
        flexBasis={0}
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        overflow="hidden"
      >
        {main}
      </box>
      {docked && drawer?.dock === "right" && (
        <Drawer docked>{drawer.content}</Drawer>
      )}
    </box>
  );
}

export function DashboardLayout({
  width,
  header,
  above,
  panels,
  below,
}: {
  readonly width: number;
  readonly header: ReactNode;
  readonly above: ReactNode;
  readonly panels?: DashboardPanels;
  readonly below: ReactNode;
}) {
  return (
    <box
      backgroundColor={theme.colors.background}
      flexDirection="column"
      height="100%"
      paddingX={PADDING_X}
      width={width}
    >
      <box
        flexDirection="row"
        flexShrink={0}
        gap={2}
        justifyContent="space-between"
      >
        {header}
      </box>
      {above}
      {panels && <DashboardBody panels={panels} width={width} />}
      {below}
    </box>
  );
}
