export interface StartupCounts {
  readonly monitors: number;
  readonly runs: number;
  readonly schedules: number;
  readonly steps: number;
  readonly workflows: number;
}

export type SplashState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly hasConfig: boolean;
      readonly counts: StartupCounts;
    };
