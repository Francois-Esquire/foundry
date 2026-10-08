export interface ModuleSummary {
  artifactId: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface ModuleDetails extends ModuleSummary {
  releases: ModuleRelease[];
  source: Record<string, string>;
}

interface ModuleView {
  id: string;
  path: string;
  title?: string;
}

export interface ModuleRelease {
  contentId: string;
  tag: string;
  views: ModuleView[];
}

export interface ModulePreview {
  origin: string;
  views: ModuleView[];
}
