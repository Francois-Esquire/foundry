import { expect, it } from "vitest";
import { createMicrosandboxRuntime } from "../node/microsandbox";
import { bootGuest } from "./helpers/guest";

const request = (url: string) => [
  "bun",
  "-e",
  `
  try {
    const response = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) });
    console.log(response.status);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
`,
];

it("allows an exact HTTPS destination and denies another hostname and port", async () => {
  const runtime = createMicrosandboxRuntime();
  await using sandbox = await bootGuest(runtime, {
    image: "docker.io/oven/bun:1-slim",
    network: { destinations: [{ host: "example.com" }], mode: "allowlist" },
  });
  const allowed = await sandbox.commands.exec(request("https://example.com"));
  expect(allowed.exitCode, allowed.stderr).toBe(0);
  expect(Number(allowed.stdout.trim())).toBe(200);
  const deniedHost = await sandbox.commands.exec(
    request("https://example.net")
  );
  expect(deniedHost.exitCode).toBe(1);
  const deniedPort = await sandbox.commands.exec(request("http://example.com"));
  expect(deniedPort.exitCode).toBe(1);
  const mismatchedAuthority = await sandbox.commands.exec([
    "bun",
    "-e",
    `
    try {
      await fetch("https://example.com", { headers: { Host: "example.net" }, signal: AbortSignal.timeout(5000) });
    } catch {
      process.exitCode = 1;
    }
  `,
  ]);
  expect(mismatchedAuthority.exitCode).toBe(1);
}, 120_000);

it("denies guest egress when no network choice is supplied", async () => {
  await using sandbox = await bootGuest(createMicrosandboxRuntime(), {
    image: "docker.io/oven/bun:1-slim",
  });
  expect(
    (await sandbox.commands.exec(request("https://example.com"))).exitCode
  ).toBe(1);
}, 120_000);
