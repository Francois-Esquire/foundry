// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScanPage } from "../../src/web/scan/scan-page";

const COMMIT = "1111111111111111111111111111111111111111";

const late = vi.hoisted(() => ({
  reject: (_: Error): void => {
    throw new Error("The page never read its late readings.");
  },
}));

vi.mock("../../src/web/scan/load-analysis", () => ({
  loadAnalysis: () =>
    Promise.resolve({
      createFileMapScanner: () => ({ reset: () => undefined }),
      scanGitHubRepository: () =>
        Promise.resolve({
          acquisitionTiming: { downloadMs: 1, listMs: 1, resolveMs: 1 },
          dataset: {
            reader: () => ({
              analysis: () =>
                Promise.resolve({
                  origin: {
                    kind: "github-repository",
                    repository: {
                      owner: "octo",
                      repo: "demo",
                      resolvedCommit: COMMIT,
                      scope: null,
                    },
                  },
                }),
            }),
            transport: {},
          },
        }),
    }),
}));

vi.mock("../../src/web/layout/load-spyglass", () => ({
  loadHeldSpyglass: () => Promise.resolve({ frames: [] }),
  loadLateReadings: () =>
    new Promise((_, reject) => {
      late.reject = reject;
    }),
}));

vi.mock("../../src/web/ui/spyglass-view", () => ({
  default: ({ late: readings }: { late: Promise<unknown> }) => {
    readings.catch(() => undefined);
    return createElement("canvas");
  },
}));

vi.mock("../../src/web/scan/analysis-summary", () => ({
  AnalysisSummary: () => null,
  gapLine: () => "",
}));

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const until = (check: () => boolean) =>
  vi.waitFor(() => {
    if (!check()) {
      throw new Error("not yet");
    }
  });

it("shows a refusal of the late readings instead of swallowing it", async () => {
  act(() => root.render(createElement(ScanPage)));
  const input = host.querySelector<HTMLInputElement>('input[name="repo"]');
  const form = host.querySelector("form");
  if (input === null || form === null) {
    throw new Error("The scan form did not render.");
  }
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setValue?.call(input, "https://github.com/octo/demo");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
  await until(() => host.querySelector("canvas") !== null);
  await act(async () => {
    late.reject(new Error("The dataset changed while it was read."));
  });
  await until(() => host.querySelector('[role="alert"]') !== null);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "The dataset changed while it was read."
  );
  expect(host.querySelector("canvas")).toBeNull();
});
