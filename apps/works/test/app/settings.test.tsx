import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "~/app/pages/settings";
import type { Vault } from "~/main/vault/vault";
import { fakeApi, openFakeVault } from "../helpers/fake-api";

const state = vi.hoisted(() => ({ vault: undefined as unknown }));

const MASKED = /^•+$/;

vi.mock("~/app/api/client", () => ({
  worksApi: () => fakeApi(state.vault as Vault),
}));

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>
  );
}

function providers() {
  return within(screen.getByRole("region", { name: "Providers" }));
}

describe("Settings vault", () => {
  let vault: Vault;

  beforeEach(async () => {
    vault = await openFakeVault({ env: { FAL_KEY: "fal-env" } });
    state.vault = vault;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows each field's source once the status arrives", async () => {
    renderSettings();

    const gateway = providers();
    expect(await gateway.findByText("Not configured")).toBeDefined();
    expect(gateway.getByText("Default fallback")).toBeDefined();

    fireEvent.click(gateway.getByRole("tab", { name: "FAL" }));
    expect(gateway.getByText("Environment")).toBeDefined();

    const integrations = within(
      screen.getByRole("region", { name: "Integrations" })
    );
    expect(integrations.getByText("Not configured")).toBeDefined();
  });

  it("saves a key through the router and then clears it", async () => {
    renderSettings();
    const claude = providers();
    await claude.findByText("Not configured");
    fireEvent.click(claude.getByRole("tab", { name: "Claude" }));

    const input = claude.getByLabelText("API Key");
    const [saveKey] = claude.getAllByRole("button", { name: "Save" });
    expect(saveKey?.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "  sk-ant-test " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await claude.findByText("Custom")).toBeDefined();
    expect(vault.resolve("claude", "apiKey")).toBe("sk-ant-test");
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("placeholder")).toMatch(MASKED);

    fireEvent.click(claude.getByRole("button", { name: "Clear" }));

    await claude.findByText("Not configured");
    expect(vault.resolve("claude", "apiKey")).toBeNull();
    expect(claude.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("validates URL fields before enabling Save", async () => {
    renderSettings();
    const claude = providers();
    await claude.findByText("Not configured");
    fireEvent.click(claude.getByRole("tab", { name: "Claude" }));

    const input = claude.getByLabelText("Base URL");
    fireEvent.change(input, { target: { value: "not a url" } });

    expect(claude.getByText("Enter a valid http(s) URL.")).toBeDefined();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("updates from main-process changes without a renderer mutation", async () => {
    renderSettings();
    const gateway = providers();
    await gateway.findByText("Not configured");

    await vault.set("gateway", "apiKey", "external-key");
    expect(await gateway.findByText("Custom")).toBeDefined();
    expect(screen.queryByDisplayValue("external-key")).toBeNull();

    await vault.set("gateway", "apiKey", null);
    await waitFor(() => {
      expect(gateway.queryByText("Custom")).toBeNull();
      expect(gateway.getByText("Not configured")).toBeDefined();
    });
  });
});
