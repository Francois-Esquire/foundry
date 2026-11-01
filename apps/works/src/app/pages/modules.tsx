import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { TabBar, TabPanel } from "~/app/components/tab-bar";
import { VignettePage } from "~/app/layout/page-vignette";
import { ModulesAudit } from "~/app/modules/audit/modules-audit";
import { ModuleCatalog } from "~/app/modules/module-catalog";

const MODULES_TABS = [
  { id: "catalog", label: "Catalog" },
  { id: "dashboard", label: "Dashboard" },
  { id: "calls", label: "Calls" },
  { id: "workflows", label: "Workflow Runs" },
  { id: "executions", label: "Execution Runs" },
  { id: "saves", label: "Artifact Saves" },
] as const;

type ModulesTab = (typeof MODULES_TABS)[number]["id"];

function modulesTab(value: string | null): ModulesTab {
  return MODULES_TABS.find((tab) => tab.id === value)?.id ?? "catalog";
}

/**
 * The permanent Modules destination. Catalog is the library itself; the
 * other tabs audit the engine run store, read-only.
 */
export function ModulesPage() {
  const [params, setParams] = useSearchParams();
  const tab = modulesTab(params.get("tab"));
  const selectTab = useCallback(
    (id: ModulesTab) => {
      // The audit scope (Module, time range) carries across audit tabs.
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("run");
          if (id === "catalog") {
            next.delete("tab");
          } else {
            next.set("tab", id);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  return (
    <VignettePage
      viewportClassName="relative min-h-full"
      vignette={{
        edgeStrength: 36,
        focalY: 30,
        radiusX: 95,
        radiusY: 90,
        spread: 75,
      }}
    >
      <div
        className={
          tab === "catalog"
            ? "mx-auto w-full max-w-4xl px-8 py-10"
            : "mx-auto w-full max-w-6xl px-8 py-10"
        }
      >
        <h1 className="font-sans font-semibold text-3xl tracking-tight">
          Modules
        </h1>
        <TabBar
          className="mt-6"
          label="Modules sections"
          onChange={selectTab}
          tabs={MODULES_TABS}
          value={tab}
        >
          {/* One panel whose value follows the tab, so the audit view (and
              its stream) stays mounted across the audit tabs. */}
          <TabPanel className="pt-6" value={tab}>
            {tab === "catalog" ? <ModuleCatalog /> : <ModulesAudit tab={tab} />}
          </TabPanel>
        </TabBar>
      </div>
    </VignettePage>
  );
}
