import { afterAll, describe, expect, test } from "bun:test";
import { type Blueprint, BlueprintSchema, DomainError } from "@orch/core";
import { type Forge, githubForge, gitlabForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { blueprintCatalog, renderBlueprint, STACK_WORKFLOW_FILE } from "@orch/iac";
import { checkResource, proposeResource, RESOURCE_ROOT, resourceBranch } from "./resource-propose";

// BLP-16: a resource is asked for as a merge or pull request in the project's own repository. These tests
// run the proposal against both forges' mocks; nothing here reaches a real forge or a cloud.

const TOKEN = "ghp_not-a-real-token-1234";
const bucket = {
  kind: "bucket",
  cloud: "gcp",
  environment: "staging",
  name: "files",
  region: "us-central1",
  project: "my-proj-1234",
} as const;
const BRANCH = resourceBranch("staging-files-bucket");

const gitlab = createMockGitlab({ scopes: ["api"] });
const github = createMockGithub({ token: TOKEN });
afterAll(() => {
  gitlab.stop();
  github.stop();
});

let n = 0;
/** A repository on one forge, seeded with `files` on its default branch, and what a test asks of it. */
function repository(kind: "gitlab" | "github", files: Record<string, string> = {}) {
  const forge: Forge =
    kind === "gitlab"
      ? gitlabForge(
          createGitlab({
            baseUrl: gitlab.url,
            auth: { type: "private-token", token: gitlab.token },
            maxRetries: 0,
          }),
        )
      : githubForge(
          createGithubClient({
            baseUrl: github.url,
            allowInsecureHttp: true,
            token: TOKEN,
            maxRetries: 0,
          }),
        );
  const ref = (
    kind === "gitlab"
      ? gitlab.addProject({ path: `fx/r${++n}`, files })
      : github.addRepo("acme", `r${++n}`, { files })
  ).id;
  const at = (path: string, branch: string) =>
    forge.repository.getFile(ref, path, branch).then(
      (f) => f.content,
      () => null,
    );
  const proposals = async () => {
    const out = [];
    for await (const m of forge.mergeRequests.list(ref, {})) out.push(m);
    return out;
  };
  const rendered = (input: unknown = bucket, others: Blueprint[] = []) => {
    const r = renderBlueprint(input, kind, RESOURCE_ROOT, others);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r;
  };
  const propose = (
    input: unknown = bucket,
    verb: "add" | "change" = "add",
    others: Blueprint[] = [],
  ) => proposeResource(forge, ref, { blueprint: input, others, verb });
  return { forge, ref, at, proposals, rendered, propose };
}

for (const kind of ["gitlab", "github"] as const) {
  describe(`a resource proposed to ${kind}`, () => {
    test("a first proposal commits the stack and its module to a branch and opens one request; the default branch is untouched", async () => {
      const r = repository(kind);
      const want = r.rendered();
      const done = await r.propose();

      expect(done).toMatchObject({ outcome: "opened", committed: true });
      expect(done.files).toEqual(want.files.map((f) => f.path));
      for (const f of want.files) {
        expect([f.path, await r.at(f.path, BRANCH)]).toEqual([f.path, f.content]);
        expect([f.path, await r.at(f.path, "main")]).toEqual([f.path, null]);
      }
      const all = await r.proposals();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        state: "opened",
        sourceBranch: BRANCH,
        targetBranch: "main",
        webUrl: done.mr?.url,
      });
      // a reviewer sees what it is, where it goes, and what it costs while idle
      const idle = blueprintCatalog()
        .kinds.find((k) => k.kind === "bucket")
        ?.clouds.find((c) => c.cloud === "gcp")?.idleCost;
      expect(all[0]?.title).toBe("Add bucket files to staging on gcp");
      expect(all[0]?.description).toContain("infra/staging/files-bucket");
      expect(all[0]?.description).toContain(idle ?? "no idle cost");
    });

    test("the same proposal again commits nothing and changes nothing", async () => {
      const r = repository(kind);
      const first = await r.propose();
      const second = await r.propose();

      expect(second).toMatchObject({ outcome: "unchanged", committed: false, mr: first.mr });
      expect(await r.proposals()).toHaveLength(1);
    });

    test("changed inputs commit on the same branch and edit the same request", async () => {
      const r = repository(kind);
      const first = await r.propose();
      const changed = { ...bucket, versioning: true };
      const second = await r.propose(changed, "change");

      expect(second).toMatchObject({ outcome: "updated", committed: true });
      expect(second.mr).toEqual(first.mr);
      for (const f of r.rendered(changed).files) {
        expect([f.path, await r.at(f.path, BRANCH)]).toEqual([f.path, f.content]);
      }
      const all = await r.proposals();
      expect(all).toHaveLength(1);
      expect(all[0]?.title).toBe("Change bucket files in staging on gcp");
    });

    test("a vendored module that is already in the repository is never rewritten, and a difference is said", async () => {
      const want = repository(kind).rendered();
      const module = want.files.filter((f) => f.path.startsWith(`${want.moduleDir}/`));
      const edited = module[0];
      if (!edited) throw new Error("no module file");
      const r = repository(kind, { [edited.path]: "# edited by hand\n" });
      await r.propose();

      expect(await r.at(edited.path, BRANCH)).toBe("# edited by hand\n");
      for (const f of module.slice(1)) expect(await r.at(f.path, BRANCH)).toBe(f.content);
      const [mr] = await r.proposals();
      expect(mr?.description).toContain(`\`${edited.path}\` differs from the shipped module`);
    });

    test("everything already on the default branch is in place: no commit, no request", async () => {
      const files = Object.fromEntries(
        repository(kind)
          .rendered()
          .files.map((f) => [f.path, f.content]),
      );
      const r = repository(kind, files);
      const done = await r.propose();

      expect(done).toMatchObject({ outcome: "in_place", committed: false, mr: null });
      expect(await r.proposals()).toHaveLength(0);
      expect(await r.forge.repository.getBranch(r.ref, BRANCH).catch(() => null)).toBeNull();
    });

    test("a vendored module edited by hand does not keep the stack's own files from being in place", async () => {
      const want = repository(kind).rendered();
      const files = Object.fromEntries(want.files.map((f) => [f.path, f.content]));
      const edited = want.files.find((f) => f.path.startsWith(`${want.moduleDir}/`));
      if (!edited) throw new Error("no module file");
      files[edited.path] = "# edited by hand\n";
      const r = repository(kind, files);
      const done = await r.propose();

      expect(done).toMatchObject({ outcome: "in_place", committed: false, mr: null });
      expect(await r.proposals()).toHaveLength(0);
    });

    test("a repository with no default branch is a 422, and nothing is written", async () => {
      const r = repository(kind);
      const headless: Forge = {
        ...r.forge,
        projects: {
          ...r.forge.projects,
          get: async (ref) => ({ ...(await r.forge.projects.get(ref)), defaultBranch: null }),
        },
      };
      const refused = await proposeResource(headless, r.ref, {
        blueprint: bucket,
        others: [],
        verb: "add",
      }).catch((e) => e);
      expect(refused).toMatchObject({ status: 422, code: "no_default_branch" });
      expect(await r.proposals()).toHaveLength(0);
    });

    test("a repository the forge does not know is a 422 about the project, not a crash", async () => {
      const r = repository(kind);
      const gone = await proposeResource(r.forge, 987654, {
        blueprint: bucket,
        others: [],
        verb: "add",
      }).catch((e) => e);
      expect(gone).toBeInstanceOf(DomainError);
      expect(gone).toMatchObject({ status: 422, code: "gitlab_project_unreachable" });
    });
  });
}

describe("the workflow that runs a project's stacks on GitHub", () => {
  test("a repository without it is told so in the request", async () => {
    const r = repository("github");
    await r.propose();
    const [pr] = await r.proposals();
    expect(pr?.description).toContain(STACK_WORKFLOW_FILE);
  });

  test("a repository with it is not", async () => {
    const r = repository("github", { [STACK_WORKFLOW_FILE]: "name: stacks\n" });
    await r.propose();
    const [pr] = await r.proposals();
    expect(pr?.description).not.toContain(STACK_WORKFLOW_FILE);
  });

  test("GitLab runs its stacks from the pipeline it already has, so says nothing of it", async () => {
    const r = repository("gitlab");
    await r.propose();
    const [mr] = await r.proposals();
    expect(mr?.description).not.toContain(STACK_WORKFLOW_FILE);
  });
});

describe("checking a resource before the forge is asked", () => {
  const refused = (input: unknown, others: Blueprint[] = []) => {
    try {
      checkResource(input, others);
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      return e as DomainError;
    }
    throw new Error("did not throw");
  };

  test("a good one gives its blueprint, its stack and its directory", () => {
    const checked = checkResource(bucket, []);
    expect(checked.blueprint).toEqual(BlueprintSchema.parse(bucket));
    expect(checked.stack).toBe("staging-files-bucket");
    expect(checked.path).toBe("infra/staging/files-bucket");
  });

  test("a key the schema refuses is named, with the reason, in a 422", () => {
    const e = refused({ ...bucket, region: "moon" });
    expect(e).toMatchObject({ status: 422, code: "invalid_resource" });
    expect(e.message).toContain("region");
    expect(e.extra.errors).toEqual([
      { path: "region", message: expect.stringContaining("GCP region") },
    ]);
  });

  test("a key the schema does not know is named and its value is not echoed", () => {
    const e = refused({ ...bucket, token: "super-secret-value" });
    expect(e.message).toContain("token");
    expect(JSON.stringify([e.message, e.extra])).not.toContain("super-secret-value");
  });

  test("a long value is cut short in what is said back, and no more than ten keys are named", () => {
    const e = refused({
      kind: "service",
      cloud: "gcp",
      environment: "staging",
      name: "api",
      region: "us-central1",
      project: "my-proj-1234",
      uses: [`bucket:${"a".repeat(400)}`],
    });
    const errors = e.extra.errors as { message: string }[];
    expect(errors.length).toBeGreaterThan(0);
    for (const m of errors) {
      expect(m.message.length).toBeLessThanOrEqual(200);
    }
    expect(e.message).not.toContain("a".repeat(250));
  });

  test("what it uses must be among the project's other resources", () => {
    const service = {
      kind: "service",
      cloud: "gcp",
      environment: "staging",
      name: "api",
      region: "us-central1",
      project: "my-proj-1234",
      uses: ["bucket:files"],
    };
    expect(refused(service).extra.errors).toEqual([
      { path: "uses", message: "bucket:files is not a resource of staging" },
    ]);
    expect(checkResource(service, [BlueprintSchema.parse(bucket)]).stack).toBe(
      "staging-api-service",
    );
  });
});
