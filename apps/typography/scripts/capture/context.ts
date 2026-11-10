import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright-core";
import type { AppSession } from "../../test/e2e/support/app";

export interface Call {
  /** When the request was sent, as an ISO 8601 time. */
  at: string;
  flow: string;
  latencyMs: number;
  model: string;
  outcome: string;
  /** What was asked for, in words. */
  request: string;
}
export interface Problem {
  flow: string;
  text: string;
}
export interface Output {
  latencyMs?: number;
  model?: string;
  source: "live" | "recorded" | "built by rule";
}
export interface Shot extends Partial<Output> {
  caption: string;
  file: string;
  flow: string;
  step: string;
  theme: string;
  width: number;
}
const IMAGE_MODEL = "openai/gpt-image-2.6/flare/edit";
const VECTOR_MODEL = "ideogram/vector/text-to-vector";
/** The most model calls one capture run may make. The flows make three. */
const CALLS_A_RUN = 3;

export class Capture {
  readonly shots: Shot[] = [];
  readonly calls: Call[] = [];
  readonly problems: Problem[] = [];
  flow = "";
  private step = 0;
  private asked = "";
  readonly app: AppSession;
  readonly out: string;
  readonly live: boolean;
  private readonly key: string | undefined;
  constructor(
    app: AppSession,
    out: string,
    live: boolean,
    key: string | undefined
  ) {
    this.app = app;
    this.out = out;
    this.live = live;
    this.key = key;
  }
  get page() {
    return this.app.page;
  }
  section(name: string) {
    return this.page.getByRole("region", { exact: true, name });
  }
  async start(flow: string) {
    this.flow = flow;
    this.step = 0;
    await mkdir(path.join(this.out, flow), { recursive: true });
    await this.app.reload();
    await this.app.goto("/import");
    if (
      (await this.page
        .getByRole("button", { name: "Black tape" })
        .getAttribute("aria-pressed")) === "true"
    ) {
      await this.page.getByRole("button", { name: "Black tape" }).click();
    }
  }
  async load(file = "Lato-Regular.ttf") {
    await this.page.getByRole("button", { name: `Load ${file}` }).click();
    await this.page
      .getByRole("cell", { exact: true, name: file })
      .first()
      .waitFor();
  }
  async shot(
    step: string,
    caption: string,
    from?: Locator,
    variants = false,
    output?: Output
  ) {
    this.step += 1;
    for (const [width, theme] of variants
      ? ([
          [1440, "white"],
          [390, "white"],
          [1440, "black"],
        ] as const)
      : ([[1440, "white"]] as const)) {
      await this.page.setViewportSize({ height: 900, width });
      if (theme === "black") {
        await this.page.getByRole("button", { name: "Black tape" }).click();
      }
      await this.page.evaluate(() => document.fonts.ready);
      if (from) {
        await from.evaluate((element) =>
          element.scrollIntoView({ block: "start" })
        );
      } else {
        await this.page
          .locator("main")
          .evaluate((element) => element.scrollTo({ top: 0 }));
      }
      await this.page.waitForTimeout(200);
      const file = `${this.flow}/${String(this.step).padStart(2, "0")}-${step}-${width}-${theme}.png`;
      await this.page.screenshot({
        path: path.join(this.out, file),
        scale: "css",
      });
      this.shots.push({
        caption,
        file,
        flow: this.flow,
        step,
        theme,
        width,
        ...output,
      });
      if (theme === "black") {
        await this.page.getByRole("button", { name: "Black tape" }).click();
      }
    }
    await this.page.setViewportSize({ height: 900, width: 1440 });
  }
  async pasteKey() {
    if (!(this.live && this.key)) {
      throw new Error(
        "Live capture requires FAL_API_KEY in the capture process environment."
      );
    }
    const field = this.page.getByLabel("fal API key", { exact: true });
    if ((await field.getAttribute("type")) !== "password") {
      throw new Error("Key field is not masked.");
    }
    await field.fill(this.key);
  }
  /** Says what the next live call asks for, so the record can name it. */
  asking(request: string) {
    this.asked = request;
  }
  problem(text: string) {
    this.problems.push({ flow: this.flow, text });
  }
  /**
   * Stands between the app and fal for the whole run. Without --live nothing
   * reaches fal. With it, one run may make at most three model calls, one of
   * them to the image model, and only to the two models the flows use.
   * Putting a reference picture on fal's storage is not a model call.
   */
  async guard() {
    await this.page.route("https://rest.fal.ai/**", async (route) => {
      await (this.live ? route.continue() : route.abort());
    });
    await this.page.route("https://fal.run/**", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      const model = new URL(request.url()).pathname.slice(1);
      const image = model === IMAGE_MODEL;
      if (
        !this.live ||
        this.calls.length >= CALLS_A_RUN ||
        (image && this.calls.some((made) => made.model === model)) ||
        !(image || model === VECTOR_MODEL)
      ) {
        this.problem("A model request was blocked by the spending guard.");
        await route.abort();
        return;
      }
      const call: Call = {
        at: new Date().toISOString(),
        flow: this.flow,
        latencyMs: 0,
        model,
        outcome: "started",
        request: this.asked,
      };
      this.calls.push(call);
      const started = performance.now();
      const finish = (outcome: string) => {
        call.latencyMs = Math.round(performance.now() - started);
        call.outcome = outcome;
      };
      request
        .response()
        .then((response) =>
          finish(response ? `HTTP ${response.status()}` : "network failed")
        )
        .catch(() => finish("network failed"));
      await route.continue();
    });
  }
  async assertNoKey() {
    if (!this.key) {
      return;
    }
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await scan(file);
        } else if (
          !entry.name.endsWith(".png") &&
          (await readFile(file)).includes(Buffer.from(this.key ?? ""))
        ) {
          throw new Error("Capture output contains the secret.");
        }
      }
    };
    await scan(this.out);
  }
}
