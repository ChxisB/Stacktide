import { startWeb } from "../src/server";
import { startBackend } from "../src/testing";
import { seedDemo, signInAs } from "./seed";

// `bun run demo`: the real API and web page over a throwaway database and a mock GitLab, filled by seed.ts.
// Both servers bind loopback and there is no setting to change that: the sign-in link below issues a session
// to the demo owner without a GitLab sign-in, which is only safe because nothing here is real.

const PORT = Number(process.env.DEMO_PORT ?? 3200);

const backend = await startBackend();
async function boot() {
  const demo = await seedDemo(backend);
  const web = startWeb({ api: backend.api, port: PORT });
  // cookies ignore the port, so the session this sets on PORT + 1 is the one the app on PORT reads
  const login = Bun.serve({
    port: PORT + 1,
    hostname: "127.0.0.1",
    fetch: () => signInAs(backend, demo, web.url.href),
  });
  // what the schedule does on a real deployment: after an apply from the page the target shows as in sync in seconds
  const drift = setInterval(() => void demo.checkDrift(), 5000);
  return { web, login, drift };
}
// a seed or a port that fails must not leave the throwaway database behind
const { web, login, drift } = await boot().catch(async (error) => {
  await backend.stop();
  throw error;
});

console.log(`
The Acme demo is ready.

  Sign in as Ada Lovelace (owner) with one click:  ${login.url}
  The app:                                         ${web.url}

GitLab is a mock and no pipeline runs: the runs on screen are seeded. Ctrl-C stops it and drops the database.`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    clearInterval(drift);
    login.stop(true);
    web.stop(true);
    await backend.stop();
    process.exit(0);
  });
}
