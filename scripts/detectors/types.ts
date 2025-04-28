// Shared types for all detectors

export interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type StepResult<T = unknown> = {
  name: string;
  durationMs: number;
  result: T;
  startTime: string;
  endTime: string;
};

export type BaseStep = StepResult;

export type TraverseFileSystemResult = {
  results: string[];
  ignored: string[];
};

export type ProjectTypeResult = {
  type: string;
  details: Record<string, boolean>;
};

export type AnalyzePackageJsonResult = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  detectedRunner: string;
  lockFiles: string[];
  frameworks: string[];
  typescript: boolean;
  warnings: string[];
};

export type MonorepoDetectionResult = {
  isMonorepo: boolean;
  workspaces: string[];
  tools: string[];
  warnings: string[];
};

export type EnvManagementResult = {
  envFiles: string[];
  dotenvUsed: boolean;
  missingEnvExample: boolean;
  envSyncIssue: boolean;
  warnings: string[];
};

export type ProjectNormalizationResult = {
  normalized: boolean;
  actions: string[];
  warnings: string[];
};

export type IntrospectReport = {
  steps: BaseStep[];
  warnings: string[];
};
