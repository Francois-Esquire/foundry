export interface ModuleSummary {
  artifactId: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface ModuleDetails extends ModuleSummary {
  source: Record<string, string>;
}
