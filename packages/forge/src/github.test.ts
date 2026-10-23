import { afterEach, expect, test } from "bun:test";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { GitlabError } from "@orch/gitlab";
import { githubForge } from "./github";
import { gitlabForge } from "./gitlab";
import { CAPABILITY_FLAGS } from "./index";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup() {
  const mock = createMockGithub();
  stops.push(mock.stop);
  const repo = mock.addRepo("platform", "api");
  const forge = githubForge(
    createGithubClient({
      baseUrl: mock.url,
      allowInsecureHttp: true,
      token: "ghp_not-a-real-token-1234",
      maxRetries: 0,
    }),
  );
  return { mock, forge, repo, project: "platform/api" };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GitlabError;
  }
  throw new Error("expected a failure");
};

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

const one = { action: "create" as const, path: "a.txt", content: "1" };

test("the GitHub adapter names exactly the capabilities in the table, and says yes only to approvalState", () => {
  const { forge } = setup();
  expect(forge.kind).toBe("github");
  expect(Object.keys(forge.capabilities).sort()).toEqual([...CAPABILITY_FLAGS].sort());
  for (const flag of CAPABILITY_FLAGS) {
    expect(forge.capabilities[flag], flag).toBe(flag === "approvalState");
  }
});

test("a group nothing has built refuses by name, and is not mistaken for a promise", async () => {
  const { forge, mock } = setup();
  const e = (() => {
    try {
      forge.variables.list({ project: "platform/api" });
    } catch (x) {
      return x as GitlabError;
    }
  })();
  expect(e).toBeInstanceOf(GitlabError);
  expect(e?.message).toBe("variables.list is not available for GitHub yet");
  // awaiting the group itself must not wait on a `then`
  expect(await Promise.resolve(forge.deployments)).toBe(forge.deployments);
  expect(mock.requests).toEqual([]);
});

test("members answer in GitLab's levels; the users group is still not built", async () => {
  const { forge, mock, repo } = setup();
  const ada = mock.addUser("ada");
  mock.addCollaborator("platform", "api", "ada", "maintain");
  mock.addOrg("platform");
  mock.addOrgMember("platform", "ada", "admin");
  expect(await forge.members.accessLevel({ project: "platform/api" }, ada.id)).toBe(40);
  expect(await forge.members.accessLevel({ project: repo.id }, ada.id)).toBe(40);
  expect(await forge.members.accessLevel({ group: "platform" }, ada.id)).toBe(50);
  expect(() => forge.users.current()).toThrow("users.current is not available for GitHub yet");
});

test("runs are read, but what GitHub lacks is said: no stages, no child pipelines, no start, no artifacts, no lint", async () => {
  const { forge, mock } = setup();
  const lacks = [
    "stages",
    "childPipelines",
    "dynamicPipeline",
    "jobArtifactFile",
    "ciLint",
  ] as const;
  for (const flag of lacks) expect(forge.capabilities[flag], flag).toBe(false);

  // read, retried and cancelled: these answer
  expect(typeof forge.pipelines.get).toBe("function");
  const run = mock.addRun("platform", "api", { status: "completed", conclusion: "failure" });
  expect((await forge.pipelines.retry("platform/api", run.id)).status).toBe("pending");
  // and the two not built yet refuse by name, before anything is sent
  const sent = mock.requests.length;
  const refused: [string, () => unknown][] = [
    ["pipelines.trigger", () => forge.pipelines.trigger("platform/api", "main")],
    ["pipelines.artifact", () => forge.pipelines.artifact("platform/api", 1, "r.json", 10)],
    ["ci.lint", () => forge.ci.lint("platform/api", "name: x")],
  ];
  for (const [what, call] of refused) {
    expect(await failure(Promise.resolve().then(call)), what).toMatchObject({
      kind: "invalid",
      message: `${what} is not available for GitHub yet`,
    });
  }
  expect(mock.requests).toHaveLength(sent);
  expect([...(await collect(forge.pipelines.bridges("platform/api", run.id)))]).toEqual([]);
});

test("an apply is gated when its environment has required reviewers, and GitLab has no such gate to ask", async () => {
  const { forge, mock } = setup();
  mock.addEnvironment("platform", "api", "orch-apply", [
    { id: 1, type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
  ]);
  mock.addEnvironment("platform", "api", "open", []);
  expect(await forge.applyGate?.("platform/api", "orch-apply")).toEqual({
    gated: true,
    reviewers: 1,
  });
  expect((await forge.applyGate?.("platform/api", "open"))?.gated).toBe(false);
  expect(gitlabForge({} as never).applyGate).toBeUndefined();
});

test.each([
  ["no owner", "api"],
  ["too deep", "a/b/c"],
  ["dots", "platform/.."],
  ["empty part", "platform/"],
  ["a query", "platform/api?x=1"],
])("a repository named with %s is refused and nothing is sent", async (_, ref) => {
  const { forge, mock } = setup();
  expect((await failure(forge.repository.getFile(ref, "a.txt", "main"))).kind).toBe("invalid");
  expect((await failure(forge.projects.get(ref))).kind).toBe("invalid");
  expect(mock.requests).toEqual([]);
});

test("a path or branch that climbs out of the repository is refused and nothing is sent", async () => {
  const { forge, mock, project } = setup();
  for (const bad of ["../x", "a//b", "a/./b", "", "a/.."]) {
    expect((await failure(forge.repository.getFile(project, bad, "main"))).kind, bad).toBe(
      "invalid",
    );
  }
  expect((await failure(forge.repository.getBranch(project, "../../other"))).kind).toBe("invalid");
  expect((await failure(forge.repository.compare(project, "main", "a..b"))).kind).toBe("invalid");
  expect(mock.requests).toEqual([]);
});

test("a repository can be named by its id", async () => {
  const { forge, repo } = setup();
  const p = await forge.projects.get(repo.id);
  expect(p).toMatchObject({ id: repo.id, path: "platform/api", defaultBranch: "main" });
  expect((await forge.repository.getFile(repo.id, "README.md", "main")).content).toBe("# api\n");
  expect((await failure(forge.projects.get(2_000_000_000))).kind).toBe("not_found");
  expect((await failure(forge.projects.get(-1))).kind).toBe("invalid");
});

test("the project list is in id order, resumes after an id, and filters by name and archived", async () => {
  const { forge, mock } = setup();
  mock.addRepo("platform", "web");
  mock.addRepo("platform", "old", { archived: true });
  const all = [];
  for await (const p of forge.projects.list()) all.push(p);
  expect(all.map((p) => p.path)).toEqual(["platform/api", "platform/web", "platform/old"]);
  const after = [];
  for await (const p of forge.projects.list({ idAfter: all[0]?.id })) after.push(p.path);
  expect(after).toEqual(["platform/web", "platform/old"]);
  const found = [];
  for await (const p of forge.projects.list({ search: "WEB" })) found.push(p.path);
  expect(found).toEqual(["platform/web"]);
  const live = [];
  for await (const p of forge.projects.list({ archived: false })) live.push(p.path);
  expect(live).toEqual(["platform/api", "platform/web"]);
});

test("a directory is not a file; the last commit of a file is the one that changed it", async () => {
  const { forge, project } = setup();
  await forge.repository.commitFiles(
    project,
    { branch: "one", startBranch: "main", message: "dir" },
    [{ action: "create", path: "d/x.txt", content: "x" }],
  );
  expect((await failure(forge.repository.getFile(project, "d", "one"))).kind).toBe("not_found");
  const first = await forge.repository.commitFiles(project, { branch: "one", message: "touch a" }, [
    { action: "create", path: "a.txt", content: "1" },
  ]);
  const second = await forge.repository.commitFiles(
    project,
    { branch: "one", message: "touch b" },
    [{ action: "create", path: "b.txt", content: "2" }],
  );
  expect((await forge.repository.getFile(project, "a.txt", "one")).lastCommitId).toBe(first.id);
  expect((await forge.repository.getFile(project, "b.txt", "one")).lastCommitId).toBe(second.id);
  expect(first.title).toBe("touch a");
});

test("a file's text survives the base64 round trip, line breaks and all", async () => {
  const { forge, project } = setup();
  const text = `${"héllo wörld, a line long enough to be wrapped by the base64 encoder\n".repeat(5)}end`;
  await forge.repository.commitFiles(project, { branch: "t", startBranch: "main", message: "t" }, [
    { action: "create", path: "t.txt", content: text },
  ]);
  expect((await forge.repository.getFile(project, "t.txt", "t")).content).toBe(text);
});

test("tags come back as a name and the commit they point at", async () => {
  const { forge, mock, project } = setup();
  const head = (await forge.repository.getBranch(project, "main")).commitId;
  mock.addTag("platform", "api", "v1", "main");
  const tags = [];
  for await (const t of forge.repository.tags(project)) tags.push(t);
  expect(tags).toEqual([{ name: "v1", commitId: head }]);
});

test("compare reads every page of a long change", async () => {
  const { forge, project } = setup();
  const files = Array.from({ length: 130 }, (_, i) => ({
    action: "create" as const,
    path: `many/f${i}.txt`,
    content: String(i),
  }));
  await forge.repository.commitFiles(
    project,
    { branch: "big", startBranch: "main", message: "many" },
    files,
  );
  const cmp = await forge.repository.compare(project, "main", "big");
  expect(cmp.files).toHaveLength(130);
  expect(cmp.commits.map((c) => c.title)).toEqual(["many"]);
  expect(cmp.timedOut).toBe(false);
});

test("a pull request that was merged is merged, and is not in the closed ones", async () => {
  const { forge, mock, project } = setup();
  await forge.repository.commitFiles(project, { branch: "m", startBranch: "main", message: "m" }, [
    one,
  ]);
  const open = await forge.mergeRequests.create(project, {
    sourceBranch: "m",
    targetBranch: "main",
    title: "m",
  });
  expect(open).toMatchObject({
    state: "opened",
    sourceBranch: "m",
    targetBranch: "main",
    description: "",
  });
  mock.mergePull("platform", "api", open.iid);
  expect((await forge.mergeRequests.get(project, open.iid)).state).toBe("merged");
  const ids = async (state?: "opened" | "closed" | "merged" | "locked") => {
    const out = [];
    for await (const p of forge.mergeRequests.list(project, { state })) out.push(p.iid);
    return out;
  };
  expect(await ids("merged")).toEqual([open.iid]);
  expect(await ids("closed")).toEqual([]);
  expect(await ids("opened")).toEqual([]);
  expect(await ids("locked")).toEqual([]);
  expect(await ids()).toEqual([open.iid]);
});

test("only a pull request GitHub calls clean is mergeable", async () => {
  const { forge, mock, project } = setup();
  await forge.repository.commitFiles(project, { branch: "s", startBranch: "main", message: "s" }, [
    one,
  ]);
  const pr = await forge.mergeRequests.create(project, {
    sourceBranch: "s",
    targetBranch: "main",
    title: "s",
  });
  const status = async () => (await forge.mergeRequests.get(project, pr.iid)).mergeStatus;
  expect(await status()).toBe("mergeable");
  mock.setMergeState("platform", "api", pr.iid, "has_hooks");
  expect(await status()).toBe("mergeable");
  for (const state of ["dirty", "blocked", "behind", "unstable", "draft"]) {
    mock.setMergeState("platform", "api", pr.iid, state);
    expect(await status(), state).toBe(state);
  }
  mock.setMergeState("platform", "api", pr.iid, "unknown");
  expect(await status()).toBeNull();
});

test("a pull request's comments are its own: another pull request's comment is not found, and is not edited", async () => {
  const { forge, mock, project } = setup();
  for (const b of ["p1", "p2"]) {
    await forge.repository.commitFiles(project, { branch: b, startBranch: "main", message: b }, [
      { action: "create", path: `${b}.txt`, content: b },
    ]);
  }
  const one = await forge.mergeRequests.create(project, {
    sourceBranch: "p1",
    targetBranch: "main",
    title: "1",
  });
  const two = await forge.mergeRequests.create(project, {
    sourceBranch: "p2",
    targetBranch: "main",
    title: "2",
  });
  const note = await forge.mergeRequests.createNote(project, one.iid, "first");
  expect(note).toEqual({ id: note.id, body: "first", system: false, authorId: 1 });
  expect(await forge.mergeRequests.updateNote(project, one.iid, note.id, "second")).toMatchObject({
    body: "second",
  });
  expect((await failure(forge.mergeRequests.getNote(project, two.iid, note.id))).kind).toBe(
    "not_found",
  );
  const patches = () =>
    mock.requests.filter((r) => r.method === "PATCH" && r.path.includes("/comments/"));
  const before = patches().length;
  expect(
    (await failure(forge.mergeRequests.updateNote(project, two.iid, note.id, "hijack"))).kind,
  ).toBe("not_found");
  expect(patches().length).toBe(before);
  expect((await forge.mergeRequests.getNote(project, one.iid, note.id)).body).toBe("second");
});

test("a commit with no files, a missing branch with no start, or a second use of a path is invalid", async () => {
  const { forge, project } = setup();
  const m = { message: "x" };
  await forge.repository.commitFiles(project, { branch: "e", startBranch: "main", ...m }, [one]);
  const tipBefore = (await forge.repository.getBranch(project, "e")).commitId;
  expect(
    (await failure(forge.repository.commitFiles(project, { branch: "e", ...m }, []))).kind,
  ).toBe("invalid");
  expect((await forge.repository.getBranch(project, "e")).commitId).toBe(tipBefore);
  expect(
    (await failure(forge.repository.commitFiles(project, { branch: "n", ...m }, [one]))).kind,
  ).toBe("invalid");
  expect(
    (
      await failure(
        forge.repository.commitFiles(project, { branch: "n", startBranch: "gone", ...m }, [one]),
      )
    ).kind,
  ).toBe("invalid");
  expect(
    (
      await failure(
        forge.repository.commitFiles(project, { branch: "n", startBranch: "main", ...m }, [
          one,
          one,
        ]),
      )
    ).kind,
  ).toBe("invalid");
  expect((await failure(forge.repository.getBranch(project, "n"))).kind).toBe("not_found");
});

test("what GitHub will not hand over whole is refused, not cut short", async () => {
  const { forge, mock, project } = setup();
  const root = "/repos/platform/api";
  mock.inject({
    method: "GET",
    path: `${root}/contents/big.bin`,
    status: 200,
    times: 1,
    body: {
      type: "file",
      path: "big.bin",
      sha: "a1",
      size: 2_000_000,
      encoding: "none",
      content: "",
    },
  });
  expect((await failure(forge.repository.getFile(project, "big.bin", "main"))).message).toContain(
    "too large",
  );
  mock.inject({
    method: "GET",
    path: `${root}/git/trees/main`,
    status: 200,
    times: 1,
    body: { sha: "t1", tree: [], truncated: true },
  });
  const tree = async () => {
    for await (const _ of forge.repository.tree(project, { ref: "main" })) {
      // drained
    }
  };
  expect((await failure(tree())).message).toContain("too large");
});

test("a comparison longer than GitHub lists says it may be incomplete", async () => {
  const { forge, mock, project } = setup();
  const page = {
    commits: Array.from({ length: 100 }, (_, i) => ({
      sha: `c${i}`,
      commit: { message: `m${i}\nbody` },
    })),
    files: Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: "modified" })),
  };
  mock.inject({
    method: "GET",
    path: "/repos/platform/api/compare/main...big",
    status: 200,
    times: 30,
    body: page,
  });
  const cmp = await forge.repository.compare(project, "main", "big");
  expect(cmp.timedOut).toBe(true);
  expect(cmp.files).toHaveLength(3000);
  expect(cmp.commits[0]).toEqual({ id: "c0", title: "m0" });
});

test("a rename keeps the old path, and a copied or changed file counts as modified", async () => {
  const { forge, mock, project } = setup();
  mock.inject({
    method: "GET",
    path: "/repos/platform/api/compare/main...x",
    status: 200,
    times: 1,
    body: {
      commits: [],
      files: [
        { filename: "new.txt", previous_filename: "old.txt", status: "renamed" },
        { filename: "c.txt", status: "copied" },
        { filename: "d.txt", status: "changed" },
        { filename: "e.txt", status: "removed" },
        { filename: "f.txt", status: "added" },
      ],
    },
  });
  const cmp = await forge.repository.compare(project, "main", "x");
  expect(cmp.files).toEqual([
    { oldPath: "old.txt", newPath: "new.txt", status: "renamed" },
    { oldPath: "c.txt", newPath: "c.txt", status: "modified" },
    { oldPath: "d.txt", newPath: "d.txt", status: "modified" },
    { oldPath: "e.txt", newPath: "e.txt", status: "deleted" },
    { oldPath: "f.txt", newPath: "f.txt", status: "added" },
  ]);
});

test("the tree under a path, one level or all, and an empty repository has none", async () => {
  const { forge, mock, project } = setup();
  await forge.repository.commitFiles(project, { branch: "t", startBranch: "main", message: "t" }, [
    { action: "create", path: "a/b/c.txt", content: "1" },
    { action: "create", path: "a/d.txt", content: "2" },
    { action: "create", path: "ab/e.txt", content: "3" },
  ]);
  const paths = async (o: { path?: string; recursive?: boolean }) => {
    const out = [];
    for await (const e of forge.repository.tree(project, { ref: "t", ...o })) out.push(e.path);
    return out.sort();
  };
  expect(await paths({ path: "a" })).toEqual(["a/b", "a/b/c.txt", "a/d.txt"]);
  expect(await paths({ path: "a/", recursive: false })).toEqual(["a/b", "a/d.txt"]);
  expect(await paths({ recursive: false })).toEqual(["README.md", "a", "ab"]);
  const empty = mock.addRepo("platform", "empty");
  Object.assign(empty, { default_branch: null });
  const none = [];
  for await (const e of forge.repository.tree("platform/empty")) none.push(e);
  expect(none).toEqual([]);
});

test("a commit never replaces a directory or a link, and moves its branch only forward", async () => {
  const { forge, mock, project } = setup();
  await forge.repository.commitFiles(project, { branch: "d", startBranch: "main", message: "d" }, [
    { action: "create", path: "dir/x.txt", content: "x" },
  ]);
  for (const action of ["create", "update", "delete"] as const) {
    const a = action === "delete" ? { action, path: "dir" } : { action, path: "dir", content: "1" };
    expect(
      (await failure(forge.repository.commitFiles(project, { branch: "d", message: "no" }, [a])))
        .kind,
      action,
    ).toBe("invalid");
  }
  mock.inject({
    method: "GET",
    path: "/repos/platform/api/contents/link",
    status: 200,
    times: 2,
    body: { type: "symlink", path: "link", sha: "s1", size: 3 },
  });
  expect((await failure(forge.repository.getFile(project, "link", "d"))).kind).toBe("not_found");
  const update = { action: "update" as const, path: "link", content: "1" };
  expect(
    (await failure(forge.repository.commitFiles(project, { branch: "d", message: "no" }, [update])))
      .kind,
  ).toBe("invalid");
  await forge.repository.commitFiles(project, { branch: "d", message: "ok" }, [
    { action: "update", path: "dir/x.txt", content: "y" },
  ]);
  const move = mock.requests.filter(
    (r) => r.method === "PATCH" && r.path.endsWith("/git/refs/heads/d"),
  );
  expect(move.map((r) => (r.body as { force: boolean }).force)).toEqual([false]);
});

test("a number that is not a whole pull request or comment number is refused and nothing is sent", async () => {
  const { forge, mock, project } = setup();
  for (const n of [0, -1, 1.5, Number.NaN]) {
    expect((await failure(forge.mergeRequests.get(project, n))).kind, String(n)).toBe("invalid");
    expect((await failure(forge.mergeRequests.getNote(project, 1, n))).kind, String(n)).toBe(
      "invalid",
    );
  }
  expect(mock.requests).toEqual([]);
});
