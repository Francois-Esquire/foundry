/**
 * Addresses: a place follows the address it is opened at, and says so when an address names nothing.
 *
 * One of the workflows of the eighth milestone, proved in real Chrome: driven
 * through the interface from an empty project, moving from place to place by
 * the links the places offer. Nothing here calls a model. Generated glyphs
 * come from recorded runs, which are saved model output replayed, or from
 * the procedural strategy, which builds by rule.
 */
import { describe, expect, it } from "vitest";
import { PORTS } from "../support/ports";
import { section } from "../support/screen";
import { LATO, startWorkflows, WORKFLOW_TIMEOUT } from "../support/workflow";

describe("four workflows from an empty project to a downloaded font, in Chrome", () => {
  const { collectLinks, deadLinks, linksMet, loadSample, on, startEmpty } =
    startWorkflows(PORTS.addresses);

  it(
    "follows an address in a session already in use, leaves a bare address alone, and says so when an address names nothing",
    async () => {
      const { app, page } = on();
      await startEmpty();
      await loadSample(LATO);
      await page.getByRole("link", { name: "Open the library" }).click();
      const faceId =
        decodeURIComponent(
          (await page
            .getByRole("link", { name: "Open in the Studio" })
            .getAttribute("href")) ?? ""
        ).split("/")[2] ?? "";
      const face = encodeURIComponent(faceId);
      const main = page.locator("main");

      // Generate follows each address in turn. A bare address changes nothing.
      const chosenScope = () =>
        page
          .getByRole("combobox", { name: "Missing in the writing system" })
          .locator("option:checked")
          .innerText();
      await app.goto(`/generate/${face}/Grek`);
      await expect.poll(chosenScope).toBe("Greek");
      await app.goto(`/generate/${face}/Deva`);
      await expect.poll(chosenScope).toBe("Devanagari");
      await app.goto("/generate");
      await section(page, "Generate").waitFor();
      expect(await chosenScope()).toBe("Devanagari");
      await app.goto("/generate/no-such-face/Klingon");
      await expect
        .poll(() => main.innerText())
        .toContain("The face in this address is not in the project.");
      expect(await chosenScope()).toBe("Devanagari");

      // Export: a subset asked for by one address does not cut down the next,
      // which asks for the face whole.
      const keeps = (name: string) =>
        section(page, "Characters").getByRole("radio", { name }).isChecked();
      await app.goto(`/export/face/${face}/Latn`);
      await section(page, "Characters").waitFor();
      await expect.poll(() => keeps("A selection")).toBe(true);
      await app.goto(`/export/face/${face}`);
      await expect.poll(() => keeps("Everything")).toBe(true);
      // What is chosen by hand stays through a bare address and a wrong one.
      await section(page, "Characters")
        .getByRole("radio", { name: "A selection" })
        .check({ force: true });
      await app.goto("/export");
      await section(page, "Characters").waitFor();
      expect(await keeps("A selection")).toBe(true);
      await app.goto("/export/face/no-such-face");
      await expect
        .poll(() => main.innerText())
        .toContain("The face in this address is not in the project");
      expect(await keeps("A selection")).toBe(true);
      await app.goto("/export/nothing/here");
      await expect
        .poll(() => main.innerText())
        .toContain("This address names nothing to plan an export from");

      // Proof says so too, and its way on to Export is there whatever has been built.
      await app.goto("/proof/nothing");
      await expect
        .poll(() => main.innerText())
        .toContain("This address names no font to prove.");
      await app.goto(`/proof/face/${face}`);
      expect(
        decodeURIComponent(
          (await page
            .getByRole("link", { name: "Plan an export" })
            .getAttribute("href")) ?? ""
        )
      ).toBe(`#/export/face/${faceId}`);
      await app.goto("/nowhere/at/all");
      await expect.poll(() => main.innerText()).toContain("No such place");
      await collectLinks();
      expect(app.errors).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );

  it("leads nowhere dead: every link met on the way names a place that exists", () => {
    expect(linksMet()).toBeGreaterThan(0);
    expect(deadLinks()).toEqual([]);
  });
});
