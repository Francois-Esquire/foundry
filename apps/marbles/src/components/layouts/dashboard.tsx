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
    mainWidth:
      body - (docked ? DRAWER_WIDTH + 1 : 0) - (showRail ? RAIL_WIDTH : 0),
    rail: showRail,
  };
}

export function dashboardMain(regions: DashboardRegions) {
  const { mainWidth } = arrange(regions);
  return { wide: mainWidth >= WIDE, width: mainWidth };
}

function filled(slot: ReactNode): boolean {
  return slot !== undefined && slot !== null && slot !== false;
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
  main,
  rail,
  drawer,
  drawerDock,
}: {
  readonly width: number;
  readonly main: ReactNode;
  readonly rail?: ReactNode;
  readonly drawer?: ReactNode;
  readonly drawerDock?: DrawerDock;
}) {
  const drawn = filled(drawer);
  const arrangement = arrange({
    drawer: drawn,
    drawerDock,
    rail: filled(rail),
    width,
  });
  const { docked } = arrangement;
  if (drawn && !docked) {
    return (
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Drawer docked={false}>{drawer}</Drawer>
      </box>
    );
  }
  return (
    <box flexDirection="row" flexGrow={1} gap={docked ? 1 : 0} minHeight={0}>
      {docked && drawerDock === "left" && <Drawer docked>{drawer}</Drawer>}
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
      {docked && drawerDock === "right" && <Drawer docked>{drawer}</Drawer>}
    </box>
  );
}

export function DashboardLayout({
  width,
  header,
  tabs,
  search,
  help,
  notices,
  main,
  rail,
  drawer,
  drawerDock,
  prompt,
  status,
  footer,
  trailingStatus,
  toolbar,
  overlay,
}: {
  readonly width: number;
  readonly header: ReactNode;
  readonly tabs: ReactNode;
  readonly search?: ReactNode;
  readonly help?: ReactNode;
  readonly notices?: ReactNode;
  readonly main: ReactNode;
  readonly rail?: ReactNode;
  readonly drawer?: ReactNode;
  readonly drawerDock?: DrawerDock;
  readonly prompt?: ReactNode;
  readonly status?: ReactNode;
  readonly footer: ReactNode;
  readonly trailingStatus?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly overlay?: ReactNode;
}) {
  const helping = filled(help);
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
        {tabs}
      </box>
      {search}
      {help}
      {notices}
      {!helping && (
        <DashboardBody
          drawer={drawer}
          drawerDock={drawerDock}
          main={main}
          rail={rail}
          width={width}
        />
      )}
      {prompt}
      {status}
      {footer}
      {trailingStatus}
      {!helping && toolbar}
      {overlay}
    </box>
  );
}
