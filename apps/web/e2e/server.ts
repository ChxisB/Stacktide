import { mkdir, writeFile } from "node:fs/promises";
import { startWeb } from "../src/server";
import { startBackend } from "../src/testing";

// The stack the browser test runs against: the same backend the screens' tests use (real API, real database,
// mock GitLab, the job worker), with the web page in front. Where everything is goes to e2e/.state.json.

const PORT = Number(process.env.E2E_PORT ?? 3111);
const PIPELINE = "stages:\n  - test\ntest:\n  stage: test\n  script:\n    - bun test\n";

const backend = await startBackend([
  {
    manifest: {
      name: "plain-app",
      version: "1.0.0",
      description: "A project that needs nothing but tests.",
      params: { type: "object", properties: {}, required: [] },
      detects: ["bun"],
      requiresVariables: [],
    },
    pipeline: PIPELINE,
  },
]);
backend.startWorker();
const org = await backend.organization("Acme");
const mock = backend.gitlab(undefined, ["api"]);
const gl = mock.addProject({
  path: "acme/web",
  defaultBranch: "main",
  files: { "bun.lock": "", "package.json": "{}" },
});
mock.addMember({ project: gl.id }, mock.tokenUser.id, 40);
const admin = await backend.signIn("Journey admin", {
  orgRoles: { [org.id]: "admin" },
  projectRoles: {},
});

const web = startWeb({ api: backend.api, port: PORT });
await mkdir(`${import.meta.dir}`, { recursive: true });
await writeFile(
  `${import.meta.dir}/.state.json`,
  JSON.stringify({
    session: admin.cookie.replace("orch_session=", ""),
    org: org.id,
    gitlab: { url: mock.url, token: mock.token, projectId: gl.id, path: gl.path },
  }),
);
console.log(`e2e stack on ${web.url}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    web.stop(true);
    await backend.stop();
    process.exit(0);
  });
}
