/** @vitest-environment happy-dom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineClient, EngineStatus } from "~/packaging/engine/client";
import { followSourceFonts } from "~/workspace/browser-fonts";
import { WorkspaceProvider } from "~/workspace/react";
import {
  ServicesProvider,
  useEngineStatus,
  useFontFamily,
} from "~/workspace/services";
import { fixtureFile, testWorkspace } from "../helpers/workspace";

const fakeEngine = () => {
  let status: EngineStatus = "idle";
  const listeners = new Set<(next: EngineStatus) => void>();
  const engine = {
    status: () => status,
    subscribe(listener: (next: EngineStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EngineClient;
  return {
    become(next: EngineStatus) {
      status = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    engine,
  };
};

function Probe() {
  const state = useEngineStatus();
  return <output>{state}</output>;
}

function Family({ faceId }: { readonly faceId: string | undefined }) {
  return <output>{useFontFamily(faceId) ?? "none"}</output>;
}

describe("services", () => {
  afterEach(cleanup);

  it("follows the engine's status", () => {
    const workspace = testWorkspace();
    const { engine, become } = fakeEngine();
    const fonts = followSourceFonts(workspace, {
      add: () => undefined,
      remove: () => undefined,
    });
    render(
      <WorkspaceProvider workspace={workspace}>
        <ServicesProvider services={{ engine, fonts }}>
          <Probe />
        </ServicesProvider>
      </WorkspaceProvider>
    );
    expect(screen.getByRole("status").textContent).toBe("idle");
    act(() => become("starting"));
    expect(screen.getByRole("status").textContent).toBe("starting");
  });

  it("gives a face its CSS family once its font is imported", async () => {
    const workspace = testWorkspace();
    const { engine } = fakeEngine();
    const fonts = followSourceFonts(workspace, {
      add: () => undefined,
      remove: () => undefined,
    });
    const view = (faceId: string | undefined) => (
      <WorkspaceProvider workspace={workspace}>
        <ServicesProvider services={{ engine, fonts }}>
          <Family faceId={faceId} />
        </ServicesProvider>
      </WorkspaceProvider>
    );
    const { rerender } = render(view(undefined));
    expect(screen.getByRole("status").textContent).toBe("none");
    await act(async () => {
      await workspace.importFonts([fixtureFile("lato")]);
    });
    rerender(view(workspace.getState().project.faces[0]?.id));
    expect(screen.getByRole("status").textContent).toContain(
      "Typography Source "
    );
  });
});
