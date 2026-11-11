/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { families } from "~/typeface/project";
import {
  useActiveFace,
  useProject,
  useWorkspace,
  useWorkspaceState,
  WorkspaceProvider,
} from "~/workspace/react";
import type { Workspace } from "~/workspace/workspace";
import { fixtureFile, testWorkspace } from "../helpers/workspace";

const providerFor =
  (workspace: Workspace) =>
  ({ children }: { readonly children: ReactNode }) => (
    <WorkspaceProvider workspace={workspace}>{children}</WorkspaceProvider>
  );

afterEach(cleanup);

describe("the React bindings", () => {
  it("hands the workspace to components below the provider", () => {
    const workspace = testWorkspace();
    const { result } = renderHook(() => useWorkspace(), {
      wrapper: providerFor(workspace),
    });
    expect(result.current).toBe(workspace);
  });

  it("says what is missing when there is no provider", () => {
    expect(() => renderHook(() => useWorkspace())).toThrow(
      "useWorkspace needs a WorkspaceProvider above it."
    );
  });

  it("renders again when the selected state changes", async () => {
    const workspace = testWorkspace();
    const ProjectName = () => (
      <h1>{useWorkspaceState((state) => state.project.name)}</h1>
    );
    render(<ProjectName />, { wrapper: providerFor(workspace) });
    expect(screen.getByRole("heading").textContent).toBe("Untitled project");

    act(() => {
      workspace.renameProject("Sofia revival");
    });
    expect(screen.getByRole("heading").textContent).toBe("Sofia revival");

    await act(async () => {
      await workspace.importFonts([fixtureFile("hebrew")]);
    });
    expect(screen.getByRole("heading").textContent).toBe("Sofia revival");
  });

  it("skips rendering when a change leaves the selected value alone", () => {
    const workspace = testWorkspace();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useWorkspaceState((state) => state.notices.length);
      },
      { wrapper: providerFor(workspace) }
    );
    const afterMount = renders;
    act(() => {
      workspace.renameProject("Renamed");
    });
    expect(renders).toBe(afterMount);
    act(() => {
      workspace.acceptCandidate("nope");
    });
    expect(result.current).toBe(1);
    expect(renders).toBe(afterMount + 1);
  });

  it("stays stable with a selector that builds a new array each time", async () => {
    const workspace = testWorkspace();
    const { result, rerender } = renderHook(
      () => useWorkspaceState((state) => families(state.project)),
      { wrapper: providerFor(workspace) }
    );
    expect(result.current).toEqual([]);

    await act(async () => {
      await workspace.importFonts([
        fixtureFile("hebrew"),
        fixtureFile("postscript"),
      ]);
    });
    expect(result.current.map((family) => family.name)).toEqual([
      "David Libre",
      "Source Code Pro",
    ]);
    rerender();
    expect(result.current.map((family) => family.name)).toEqual([
      "David Libre",
      "Source Code Pro",
    ]);
  });

  it("keeps the selection while the state and the selector stay the same", () => {
    const workspace = testWorkspace();
    const selectNotices = (state: { readonly notices: readonly unknown[] }) => [
      ...state.notices,
    ];
    const { result, rerender } = renderHook(
      () => useWorkspaceState(selectNotices),
      { wrapper: providerFor(workspace) }
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("stops listening when the component goes away", () => {
    const workspace = testWorkspace();
    let renders = 0;
    const { unmount } = renderHook(
      () => {
        renders += 1;
        return useWorkspaceState((state) => state.project.name);
      },
      { wrapper: providerFor(workspace) }
    );
    unmount();
    const afterUnmount = renders;
    workspace.renameProject("Nobody is listening");
    expect(renders).toBe(afterUnmount);
  });

  it("reads the open project and the active face, and follows them", async () => {
    const workspace = testWorkspace();
    const { result } = renderHook(
      () => ({ face: useActiveFace(), project: useProject() }),
      { wrapper: providerFor(workspace) }
    );
    expect(result.current.face).toBeUndefined();
    expect(result.current.project).toBe(workspace.getState().project);

    await act(async () => {
      await workspace.importFonts([fixtureFile("lato"), fixtureFile("hebrew")]);
    });
    const { project } = workspace.getState();
    expect(result.current.project).toBe(project);
    expect(result.current.face).toBe(project.faces[0]);

    act(() => {
      workspace.setActiveFace(project.faces[1]?.id ?? "");
    });
    expect(result.current.face).toBe(project.faces[1]);
  });
});
