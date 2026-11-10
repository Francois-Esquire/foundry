/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UnloadGuard } from "~/app/unload-guard";
import { WorkspaceProvider } from "~/workspace/react";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

afterEach(cleanup);

/** True when the page asked the browser to check before unloading. */
const asksBeforeUnload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("UnloadGuard", () => {
  it("lets an empty project go without a question", () => {
    render(
      <WorkspaceProvider workspace={testWorkspace()}>
        <UnloadGuard />
      </WorkspaceProvider>
    );
    expect(asksBeforeUnload()).toBe(false);
  });

  it("asks before the page unloads while the project holds an imported font", async () => {
    const workspace = testWorkspace();
    render(
      <WorkspaceProvider workspace={workspace}>
        <UnloadGuard />
      </WorkspaceProvider>
    );
    const { sourceId } = await importOne(workspace, fixtureFile("lato"));
    expect(asksBeforeUnload()).toBe(true);
    workspace.removeSource(sourceId);
    expect(asksBeforeUnload()).toBe(false);
  });

  it("stops asking once the shell is taken down", async () => {
    const workspace = testWorkspace();
    const { unmount } = render(
      <WorkspaceProvider workspace={workspace}>
        <UnloadGuard />
      </WorkspaceProvider>
    );
    await importOne(workspace, fixtureFile("lato"));
    unmount();
    expect(asksBeforeUnload()).toBe(false);
  });
});
