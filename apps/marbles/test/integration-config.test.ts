import { describe, expect, it } from "vitest";

import base from "../vitest.config";
import integration from "../vitest.integration.config";

const INTEGRATION = "test/**/*.integration.test.ts";

describe("integration test config", () => {
  it("keeps the base test options", () => {
    expect(integration.test).toMatchObject({
      execArgv: base.test?.execArgv,
      globalSetup: base.test?.globalSetup,
      globals: base.test?.globals,
      server: base.test?.server,
      setupFiles: base.test?.setupFiles,
    });
  });

  it("selects only the integration tests", () => {
    expect(integration.test?.include).toEqual([INTEGRATION]);
    expect(integration.test?.exclude ?? []).not.toContain(INTEGRATION);
  });
});
