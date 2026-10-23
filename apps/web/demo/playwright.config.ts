import { defineConfig } from "@playwright/test";

const port = Number(process.env.DEMO_PORT ?? 3210); // not 3200: `bun run demo` may be open

// DEMO-4: the real demo server (server.ts) in front of a browser that visits every page and takes a picture of it.
export default defineConfig({
  testDir: ".",
  testMatch: process.env.DEMO_SPEC ?? "shots.e2e.ts", // the demo's other tests are `bun test`'s; DEMO_SPEC=align.e2e.ts is `bun run demo:align`
  workers: 1,
  timeout: 120_000,
  reporter: "list",
  webServer: {
    command: "bun --env-file=../../../.env.example server.ts",
    url: `http://127.0.0.1:${port}/health`,
    env: { DEMO_PORT: String(port) },
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
