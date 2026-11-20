export const RESPONSIBILITY_GROUPS_SCHEMA_VERSION = 2;

export interface ResponsibilityGroup {
  anchor: string;
  anchorModule?: string;
  anchorWeight: number;
  id: string;
  label: string;
  modules: string[];
  responsibilities: string[];
}

export interface ResponsibilityGroupsPackage {
  groups: ResponsibilityGroup[];
  id: string;
  independent: string[];
}

export type PackageResponsibilityGroups = Pick<
  ResponsibilityGroupsPackage,
  "groups" | "independent"
>;

export interface ResponsibilityGroups {
  missing: string[];
  packages: ResponsibilityGroupsPackage[];
}
