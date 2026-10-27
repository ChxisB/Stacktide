import { afterAll, beforeAll, expect, test } from "bun:test";
import { githubForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { configure, getConfig, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mount, startBackend } from "./testing";

// FRG-24: the journey of UI-9 on a GitHub repository, through the screens and the real API, with the mock
// GitHub standing in for GitHub: connect, import by address, set the pipeline up, see what GitHub cannot do.

const TOKEN = "ghp_not-a-real-token-1234";
const WORKFLOW = ".github/workflows/orch.yml";

const waited = getConfig().asyncUtilTimeout;
let backend: Awaited<ReturnType<typeof startBackend>>;
beforeAll(async () => {
  // every wait here is on a real API and a real database
  configure({ asyncUtilTimeout: 5000 });
  backend = await startBackend();
});
afterAll(async () => {
  configure({ asyncUtilTimeout: waited });
  await backend.stop();
});

test("connect GitHub, import a repository by its address, open the pipeline's pull request, and be told what GitHub lacks", async () => {
  window.location.hash = "#/projects";
  const org = await backend.organization("Acme");
  const hub = backend.github(TOKEN);
  const repo = hub.addRepo("acme", "web", { files: { "bun.lock": "", "package.json": "{}" } });
  const forge = githubForge(
    createGithubClient({ baseUrl: hub.url, allowInsecureHttp: true, token: TOKEN, maxRetries: 0 }),
  );
  const admin = await backend.signIn("Journey admin", {
    orgRoles: { [org.id]: "admin" },
    projectRoles: {},
  });
  mount(admin.client);
  const user = userEvent.setup();
  const nav = async (page: string) =>
    user.click(
      within(await screen.findByRole("navigation", { name: "Main" })).getByRole("link", {
        name: page,
      }),
    );

  // 1. connect GitHub with a token, then paste the repository's address: it is found and ticked
  await user.click(await screen.findByRole("button", { name: "Add a connection" }));
  await user.selectOptions(await screen.findByLabelText("Forge"), "GitHub");
  await user.clear(screen.getByLabelText("GitHub address"));
  await user.type(screen.getByLabelText("GitHub address"), hub.url);
  await user.type(screen.getByLabelText("Access token"), TOKEN);
  await user.click(screen.getByRole("button", { name: "Connect" }));
  const form = await screen.findByRole("form", { name: "Repository address" });
  await user.type(within(form).getByLabelText("Repository address"), `${hub.url}/acme/web`);
  await user.click(within(form).getByRole("button", { name: "Find" }));
  const box = (await screen.findByRole("checkbox", { name: /^acme\/web/ })) as HTMLInputElement;
  await waitFor(() => expect(box.checked).toBe(true));
  await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
  const results = await screen.findByRole("region", { name: "Import results" });
  expect(within(results).getByRole("listitem").textContent).toContain("acme/web: created");
  expect(document.body.innerHTML).not.toContain(TOKEN);

  // 2. its pipeline: the review names the workflow file, says why GitHub did not lint it, and the pull request holds it
  await nav("Pipeline");
  await user.click(await screen.findByRole("button", { name: "Choose a template" }));
  await user.click(await screen.findByRole("radio", { name: /^bun-app / }));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("form", { name: "Step 3: Parameters" });
  expect(screen.getByLabelText("GitHub connection")).toBeTruthy();
  const preview = (await screen.findByRole("button", {
    name: "Preview pipeline",
  })) as HTMLButtonElement;
  await waitFor(() => expect(preview.disabled).toBe(false));
  await user.click(preview);
  const review = await screen.findByRole("region", { name: "Step 4: Review" });
  expect(within(review).getByRole("heading", { level: 2 }).textContent).toContain(WORKFLOW);
  expect(review.textContent).toContain("GitHub does not check a workflow");
  expect(review.textContent).not.toContain("GitLab");
  expect(review.textContent).not.toContain(".gitlab-ci.yml");
  await user.click(await screen.findByRole("button", { name: "Create merge request" }));
  const done = await screen.findByRole("region", { name: "Result" });
  expect(done.textContent).toContain("merge request !1");
  const pulls = [];
  for await (const p of forge.mergeRequests.list(repo.id)) pulls.push(p);
  expect(pulls.map((p) => p.sourceBranch)).toEqual(["orch/pipeline"]);
  // the file the review named is the file the branch holds, and the default branch is untouched
  expect((await forge.repository.getFile(repo.id, WORKFLOW, "orch/pipeline")).content).toContain(
    "jobs:",
  );
  await expect(forge.repository.getFile(repo.id, WORKFLOW, "main")).rejects.toMatchObject({
    kind: "not_found",
  });

  // 3. the status page reads GitHub's deployments in GitHub's words (CLD-10); it still has no GitLab to name
  await nav("Status");
  const deployments = await screen.findByRole("region", { name: "Deployments" });
  expect(deployments.textContent).toContain("What GitHub says is deployed");
  expect(deployments.textContent).not.toContain("GitLab");
  await within(deployments).findByRole("button", { name: "Refresh" });
  expect(document.body.innerHTML).not.toContain(TOKEN);
}, 60_000);
