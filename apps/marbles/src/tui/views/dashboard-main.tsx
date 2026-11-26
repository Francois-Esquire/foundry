import { UsageBreakdown } from "~/components/blocks/operating-overview";
import { CatalogLayout } from "~/components/layouts/catalog";
import type { MainModel } from "../state/dashboard-views";
import { DashboardCatalog } from "./dashboard-catalog";
import { DashboardOverview } from "./dashboard-overview";
import { FeedView } from "./feed";
import { Inspector } from "./inspector";

export function DashboardMain({
  main,
  height,
  wide,
  width,
}: {
  readonly main: MainModel;
  readonly height: number;
  readonly wide: boolean;
  readonly width: number;
}) {
  switch (main.kind) {
    case "feed":
      return <FeedView feed={main.feed} width={width} />;
    case "details":
      return <Inspector {...main.inspector} />;
    case "usage":
      return <UsageBreakdown active={main.active} usage={main.usage} />;
    case "catalog":
      return (
        <CatalogLayout
          catalog={
            <DashboardCatalog
              besideDetails={main.details !== undefined}
              catalog={main.catalog}
              width={width}
            />
          }
          details={main.details && <Inspector {...main.details} />}
        />
      );
    default:
      return (
        <DashboardOverview
          height={height}
          overview={main.overview}
          wide={wide}
          width={width}
        />
      );
  }
}
