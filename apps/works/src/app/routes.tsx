import { Navigate, Route, Routes } from "react-router";
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
