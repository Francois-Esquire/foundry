// The browser analysis asset, loaded by URL on the page's first scan and
// never before: it holds TypeScript, ts-morph and dependency-cruiser, many
// megabytes the viewer itself never needs. It sits beside the scan page
// (`analysis/` under the page's directory, wherever the site serves it),
// so the page names it relative to its own document. Only its types are
// imported here; the viewer's build never resolves the module.

export type BrowserAnalysis = typeof import("../../lib/browser-analysis");

/** Where the asset is, relative to the scan page. */
const ANALYSIS_ASSET = "analysis/spyglass-analysis.js";

let loading: Promise<BrowserAnalysis> | undefined;

/** The asset, loaded once; a failed load is tried again on the next call. */
export function loadAnalysis(): Promise<BrowserAnalysis> {
  if (loading === undefined) {
    const url = new URL(ANALYSIS_ASSET, document.baseURI).href;
    loading = (
      import(/* @vite-ignore */ url) as Promise<BrowserAnalysis>
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
