import { Navigate, Route, Routes } from "react-router";
import { HomePage } from "~/app/pages/home";
import { ModuleAppPage } from "~/app/pages/module-app";
import { ModuleLibraryPage } from "~/app/pages/module-library";
import { ModuleManagementPage } from "~/app/pages/module-management";
import { SettingsPage } from "~/app/pages/settings";

export function WorksRoutes() {
  return (
    <Routes>
      <Route element={<HomePage />} index />
      <Route element={<ModuleLibraryPage />} path="modules" />
      <Route element={<ModuleManagementPage />} path="modules/:moduleId" />
      <Route element={<ModuleAppPage />} path="m/:moduleId" />
      <Route element={<SettingsPage />} path="settings" />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
