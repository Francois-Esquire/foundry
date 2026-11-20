export const FILE_ROLES_SCHEMA_VERSION = 1;

export type FileRole = "junction" | "mixed" | "commons" | "unknown";

export interface FileRoleModule {
  fanIn: number;
  highFanIn: boolean;
  module: string;
  role?: FileRole;
}

export interface FileRolesPackage {
  highFanInCutoff: number;
  id: string;
  modules: FileRoleModule[];
}

export interface FileRoles {
  missing: string[];
  packages: FileRolesPackage[];
}
