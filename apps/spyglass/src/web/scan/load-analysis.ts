import analysisUrl from "../../../dist/analysis/spyglass-analysis.js?url";

export type BrowserAnalysis = typeof import("../../lib/browser-analysis");

let loading: Promise<BrowserAnalysis> | undefined;

export function loadAnalysis(): Promise<BrowserAnalysis> {
  if (loading === undefined) {
    loading = (
      import(/* @vite-ignore */ analysisUrl) as Promise<BrowserAnalysis>
    ).catch((error: unknown) => {
      loading = undefined;
      throw new Error(
        "The analysis engine could not be loaded. Check the connection and try again.",
        { cause: error }
      );
    });
  }
  return loading;
}
