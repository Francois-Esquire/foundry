import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(
  base,
  defineConfig({
    test: { exclude: [], include: ["src/test/**/*-vendor.test.ts"] },
  })
);
