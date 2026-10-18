import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3111);

// UI-9: the journey of a new team in a real browser. e2e/server.ts starts the real API on a fresh database, the
// worker, a mock GitLab and the web page, and signs an admin in; the test drives the page.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts", // not *.test.ts / *.spec.ts: `bun test` would pick those up
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: "bun --env-file=../../.env.example e2e/server.ts",
    url: `http://127.0.0.1:${port}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
