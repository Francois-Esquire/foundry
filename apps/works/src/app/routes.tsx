import { Navigate, Route, Routes } from "react-router";
import { HomePage } from "~/app/pages/home";
import { ModuleWorkspacePage } from "~/app/pages/module-workspace";
import { SettingsPage } from "~/app/pages/settings";

export function WorksRoutes() {
  return (
    <Routes>
      <Route element={<HomePage />} index />
      <Route element={<ModuleWorkspacePage />} path="modules/:moduleId" />
      <Route element={<SettingsPage />} path="settings" />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
