import { Navigate, Route, type RouteObject, Routes } from "react-router";
import { Shell } from "~/app/layout/shell";
import { ArtifactsPage } from "~/app/pages/artifacts";
import { HomePage } from "~/app/pages/home";
import { ModuleAppPage } from "~/app/pages/module-app";
import { ModuleManagementPage } from "~/app/pages/module-management";
import { ModulesPage } from "~/app/pages/modules";
import { SettingsPage } from "~/app/pages/settings";

export function WorksRoutes() {
  return (
    <Routes>
      <Route element={<HomePage />} index />
      <Route element={<ArtifactsPage />} path="artifacts" />
      <Route element={<ArtifactsPage />} path="artifacts/:artifactId" />
      <Route element={<ModulesPage />} path="modules" />
      <Route element={<ModuleManagementPage />} path="modules/:moduleId" />
      <Route element={<ModuleAppPage />} path="m/:moduleId" />
      <Route element={<SettingsPage />} path="settings" />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}

/**
 * The window's one data route: the shell around every page. A data router
 * is what lets a page block leaving it (an editor with unsaved work).
 */
export function worksRouteObjects(): RouteObject[] {
  return [
    {
      element: (
        <Shell>
          <WorksRoutes />
        </Shell>
      ),
      path: "*",
    },
  ];
}
