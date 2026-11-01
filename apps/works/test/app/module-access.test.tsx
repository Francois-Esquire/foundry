import "../helpers/mock-module-source";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ARTIFACT_CAPABILITIES } from "~/main/artifacts/gateway/host";
import { EXECUTION_CAPABILITIES } from "~/main/execution/capabilities";
import type { WorksCapability } from "~/main/gateway/provider-kit";
import { ModuleAccess } from "~/main/modules/access";
import { modulePersistence } from "~/main/modules/artifact-store";
import {
  capabilityProviders,
  describedCapabilities,
  worksCapabilityCatalog,
} from "~/main/modules/capabilities";
import { createModuleLibrary } from "~/main/modules/library";
import { ModulePower } from "~/main/modules/power";
import { ModuleSettings } from "~/main/modules/settings";
import { fakeApi, openFakeVault } from "../helpers/fake-api";
import { inlineExecution } from "../helpers/inline-execution";
import { publishStrict } from "../helpers/module-build";
import { renderApp } from "../helpers/render-app";
import { unrecordedSaves } from "../helpers/source-saves";
import { weatherProvider } from "../helpers/weather-provider";

const STEPS_LIMITS = /Default 20 steps · Ceiling 20 steps/u;
const NO_SHRINK = /never shrink the build sandbox/u;
const MEMORY_DEFAULTS = /Default 2 GiB \(released app 512 MiB\) · Ceiling/u;
const EFFECTIVE_STEPS = /Effective 12 steps/u;
const active = vi.hoisted(() => ({
  api: undefined as ReturnType<typeof fakeApi> | undefined,
}));
vi.mock("~/app/api/client", () => ({ worksApi: () => active.api }));
const directories: string[] = [];
afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

const FORECAST = {
  capabilities: [
    {
      alias: "weather",
      capability: "host.weather.read",
      constraints: { city: "Oslo" },
      reason: "Shows the forecast",
      required: true,
      version: 1,
    },
  ],
  network: {
    destinations: [{ host: "api.example.com", ports: [443] }],
    reason: "Loads forecasts",
  },
};

async function fixture(
  manifest: object = FORECAST,
  capabilities: readonly WorksCapability[] = [weatherProvider()]
) {
  const directory = await mkdtemp(path.join(tmpdir(), "works-access-ui-"));
  directories.push(directory);
  const store = new InMemoryArtifactStore();
  const library = createModuleLibrary(store, {
    catalog: worksCapabilityCatalog(capabilityProviders(capabilities)),
    saves: unrecordedSaves,
  });
  const module = await library.create("Forecast");
  await publishStrict(library, module.id, "0.1.0", manifest);
  const execution = {
    ...inlineExecution,
    configureModuleQueues: () => undefined,
  };
  const stop = vi.fn((_moduleId: string) => Promise.resolve());
  const access = new ModuleAccess({
    capabilities,
    execution,
    library,
    runtime: { revoked: () => undefined },
    store: modulePersistence(store).modules,
  });
  const power = modulePower(
    execution,
    path.join(directory, "module-power.json"),
    stop
  );
  active.api = fakeApi(await openFakeVault(), library, {
    access,
    moduleSettings: new ModuleSettings({
      directory: path.join(directory, "module-settings"),
      execution,
      library,
    }),
    power,
  });
  renderApp(`/modules/${encodeURIComponent(module.id)}`);
  return { access, module, power, stop };
}

function modulePower(
  execution: ConstructorParameters<typeof ModulePower>[0]["execution"],
  file: string,
  stop: (moduleId: string) => Promise<void>
) {
  const power = new ModulePower({ execution, file });
  power.govern({ stop });
  return power;
}

async function openAccess() {
  const tab = await screen.findByRole("tab", { name: "Access & settings" });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  return screen.findByRole("region", { name: "Access" });
}

it("shows requests, scope and Grants, and approves and revokes them in Access", async () => {
  await fixture();
  const access = await openAccess();
  expect(
    await within(access).findByText("Requests of version 0.1.0")
  ).toBeDefined();
  const requests = within(access).getByRole("list", { name: "Requests" });
  const [weather, network] = within(requests).getAllByRole("listitem");
  expect(weather?.textContent).toContain("Required");
  expect(weather?.textContent).toContain("Needs approval to start");
  expect(network?.textContent).toContain("Optional");
  expect(network?.textContent).toContain("api.example.com:443");
  expect(network?.textContent).toContain(
    "Only HTTPS to these destinations is allowed. Approving or revoking network access stops and restarts the app if it is open."
  );
  expect(within(access).getByText("Nothing is approved.")).toBeDefined();
  // Whether the app's own files outlive a stop, as its Manifest declares.
  expect(
    within(access).getByText("Kept on this device between runs", {
      selector: "dd",
    })
  ).toBeDefined();

  fireEvent.click(
    within(access).getByRole("button", { name: "Approve weather" })
  );
  await within(access).findByRole("button", {
    name: "Revoke host.weather.read",
  });
  fireEvent.click(
    within(access).getByRole("button", { name: "Approve Network access" })
  );
  const revokeNetwork = await within(access).findByRole("button", {
    name: "Revoke network",
  });
  expect(revokeNetwork.closest("li")?.textContent).toContain(
    "Revoking stops and restarts the app"
  );
  expect(
    within(access).getByText("api.example.com:443", { selector: "dd" })
  ).toBeDefined();
  expect(
    within(access).queryByRole("button", { name: "Approve weather" })
  ).toBeNull();

  fireEvent.click(
    within(access).getByRole("button", { name: "Revoke network" })
  );
  await waitFor(() =>
    expect(
      within(access).queryByRole("button", { name: "Revoke network" })
    ).toBeNull()
  );
  expect(within(access).getByText("None", { selector: "dd" })).toBeDefined();
});

it("shows, approves and revokes a broader Artifact scope and the workflows a Module may start", async () => {
  await fixture(
    {
      capabilities: [
        {
          alias: "files",
          capability: ARTIFACT_CAPABILITIES.list,
          constraints: { types: ["text/markdown"] },
          reason: "Lists your notes",
          version: 1,
        },
        {
          alias: "start",
          capability: EXECUTION_CAPABILITIES.start,
          constraints: { workflows: ["works.text.summarize@1"] },
          reason: "Summarizes notes",
          version: 1,
        },
      ],
    },
    describedCapabilities()
  );
  const access = await openAccess();
  const requests = await within(access).findByRole("list", {
    name: "Requests",
  });
  const [files, start] = within(requests).getAllByRole("listitem");
  expect(files?.textContent).toContain("Artifact types: text/markdown");
  expect(start?.textContent).toContain("Workflows: works.text.summarize@1");
  expect(
    within(access).getByText(
      "Only files opened for or created by this Module",
      { selector: "dd" }
    )
  ).toBeDefined();
  expect(
    within(access).getByText("No workflows", { selector: "dd" })
  ).toBeDefined();

  fireEvent.click(
    within(access).getByRole("button", { name: "Approve files" })
  );
  await within(access).findByRole("button", {
    name: `Revoke ${ARTIFACT_CAPABILITIES.list}`,
  });
  fireEvent.click(
    within(access).getByRole("button", { name: "Approve start" })
  );
  await within(access).findByRole("button", {
    name: `Revoke ${EXECUTION_CAPABILITIES.start}`,
  });
  expect(
    within(access).getByText(
      "Only files opened for or created by this Module, and every text/markdown Artifact",
      { selector: "dd" }
    )
  ).toBeDefined();
  expect(
    within(access).getByText("works.text.summarize@1", { selector: "dd" })
  ).toBeDefined();

  fireEvent.click(
    within(access).getByRole("button", {
      name: `Revoke ${ARTIFACT_CAPABILITIES.list}`,
    })
  );
  await within(access).findByText(
    "Only files opened for or created by this Module",
    { selector: "dd" }
  );
});

it("edits Module settings beside Access, reports refusals, and never approves access", async () => {
  await fixture();
  await openAccess();
  const settings = await screen.findByRole("region", {
    name: "Module settings",
  });
  const steps = await within(settings).findByLabelText("authoring.maxSteps");
  expect(within(settings).getByText(STEPS_LIMITS)).toBeDefined();
  expect(within(settings).getByText(NO_SHRINK)).toBeDefined();
  // Both sandbox defaults come from main's host policy.
  expect(within(settings).getByText(MEMORY_DEFAULTS)).toBeDefined();

  fireEvent.change(steps, { target: { value: "30" } });
  fireEvent.click(
    within(settings).getByRole("button", { name: "Save settings" })
  );
  await waitFor(() => expect(steps.getAttribute("aria-invalid")).toBe("true"));
  expect(within(settings).getAllByRole("alert").length).toBeGreaterThan(0);

  fireEvent.change(steps, { target: { value: "12" } });
  fireEvent.click(
    within(settings).getByRole("button", { name: "Save settings" })
  );
  expect(await within(settings).findByText("Settings saved")).toBeDefined();
  expect(within(settings).getByText(EFFECTIVE_STEPS)).toBeDefined();

  // Saving settings approved nothing.
  const access = screen.getByRole("region", { name: "Access" });
  expect(await within(access).findByText("Nothing is approved.")).toBeDefined();
  expect(
    within(access).getByRole("button", { name: "Approve weather" })
  ).toBeDefined();
});

it("turns the Module off with its sandbox cleanup and back on", async () => {
  const { module, stop } = await fixture();
  const toggle = await screen.findByRole("switch", { name: "Module on" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(screen.getByText("On")).toBeDefined();

  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  );
  expect(stop).toHaveBeenCalledWith(module.id);
  expect(screen.getByText("Off")).toBeDefined();

  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(stop).toHaveBeenCalledTimes(1);
});

it("refreshes Access after on/off, and on/off after a network change", async () => {
  const { access, power } = await fixture();
  const panel = await openAccess();
  await within(panel).findByText("Requests of version 0.1.0");
  const toggle = await screen.findByRole("switch", { name: "Module on" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  const accessReads = vi.spyOn(access, "get");
  const powerReads = vi.spyOn(power, "get");

  // Off stops the app, which Access shows as its status.
  fireEvent.click(toggle);
  await waitFor(() => expect(accessReads).toHaveBeenCalled());

  // A network approval restarts the app, which on/off shows.
  powerReads.mockClear();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Approve Network access" })
  );
  await within(panel).findByRole("button", { name: "Revoke network" });
  await waitFor(() => expect(powerReads).toHaveBeenCalled());
});

it("says when on/off cannot be read instead of hiding the switch", async () => {
  const unreadable = vi
    .spyOn(ModulePower.prototype, "get")
    .mockRejectedValue(new Error("Power is unreadable"));
  onTestFinished(() => unreadable.mockRestore());
  await fixture();
  await screen.findByText("Power is unreadable");
  expect(screen.queryByRole("switch", { name: "Module on" })).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});
