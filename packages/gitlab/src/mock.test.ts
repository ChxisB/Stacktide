import { afterEach, describe, expect, test } from "bun:test";
import { createGitlab, GitlabError, isFinished } from "./index";
import { createMockGitlab } from "./mock/server";

function setup(opts: Parameters<typeof createMockGitlab>[0] = {}) {
  const mock = createMockGitlab(opts);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, api };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("mock server", () => {
  test("rejects a wrong token with 401, accepts either auth style", async () => {
    const { mock } = setup();
    const bad = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: "wrong-token-123" },
      maxRetries: 0,
    });
    await expect(bad.projects.get(1).catch((e) => e.kind)).resolves.toBe("unauthorized");
    const oauth = createGitlab({ baseUrl: mock.url, auth: { type: "oauth", token: mock.token } });
    mock.addProject({ path: "g/p" });
    expect((await oauth.projects.get("g/p")).path).toBe("g/p");
    mock.stop();
  });

  test("lists projects in id order across pages (keyset-style Link headers)", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => mock.addProject({ path: `g/p${i}` }).id);
    const listed = await collect(api.projects.list());
    expect(listed.map((p) => p.id)).toEqual(ids);
    expect(mock.requests.filter((r) => r.path === "/api/v4/projects")).toHaveLength(3);
    mock.stop();
  });

  test("idAfter resumes a listing after that id, across pages", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => mock.addProject({ path: `g/p${i}` }).id);
    const rest = await collect(api.projects.list({ idAfter: ids[1] }));
    expect(rest.map((p) => p.id)).toEqual(ids.slice(2));
    expect(await collect(api.projects.list({ idAfter: ids[4] }))).toEqual([]);
    mock.stop();
  });

  test("filters by archived and search; an empty repository has no default branch", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/live" });
    mock.addProject({ path: "g/old", archived: true });
    mock.addProject({ path: "g/empty", defaultBranch: null });
    expect((await collect(api.projects.list({ archived: true }))).map((p) => p.path)).toEqual([
      "g/old",
    ]);
    expect((await collect(api.projects.list({ search: "liv" }))).map((p) => p.path)).toEqual([
      "g/live",
    ]);
    expect((await api.projects.get("g/empty")).defaultBranch).toBeNull();
    mock.stop();
  });
});

describe("pipelines", () => {
  const CI = 'build:\n  stage: build\n  script:\n    - "true"\ntest:\n  script:\n    - "true"\n';
  const ready = (opts: Parameters<typeof setup>[0] = {}) => {
    const s = setup(opts);
    s.mock.addProject({ path: "g/p", files: { ".gitlab-ci.yml": CI } });
    return s;
  };

  test("trigger variables reach GitLab but never come back or leak into errors", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main", [
      { key: "TOKEN", value: "super-secret-value" },
      { key: "CERT", value: "-----BEGIN-----", type: "file" },
    ]);
    expect(mock.pipelineVariables(p.id)).toEqual([
      { key: "TOKEN", value: "super-secret-value" },
      { key: "CERT", value: "-----BEGIN-----" },
    ]);
    const shown = JSON.stringify([
      p,
      await api.pipelines.get("g/p", p.id),
      await collect(api.pipelines.jobs("g/p", p.id)),
    ]);
    expect(shown).not.toContain("super-secret-value");
    mock.stop();
  });

  test("an error that echoes a trigger variable is scrubbed", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ message: "invalid value super-secret-value" }, { status: 400 }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const err = await api.pipelines
      .trigger("g/p", "main", [{ key: "TOKEN", value: "super-secret-value" }])
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(err.message).not.toContain("super-secret-value");
    server.stop(true);
  });

  test("jobs follow the CI file; retry restarts failed jobs, cancel stops unfinished ones", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    expect(p.status).toBe("pending");
    expect((await collect(api.pipelines.jobs("g/p", p.id))).map((j) => j.stage)).toEqual([
      "build",
      "test",
    ]);

    mock.finishPipeline(p.id, "failed");
    expect((await api.pipelines.get("g/p", p.id)).status).toBe("failed");
    expect(isFinished((await api.pipelines.get("g/p", p.id)).status)).toBe(true);
    expect((await api.pipelines.retry("g/p", p.id)).status).toBe("pending");
    expect((await api.pipelines.cancel("g/p", p.id)).status).toBe("canceled");
    const jobs = await collect(api.pipelines.jobs("g/p", p.id));
    expect(jobs.every((j) => j.status === "canceled")).toBe(true);

    mock.finishPipeline(p.id, "success");
    expect((await api.pipelines.cancel("g/p", p.id)).status).toBe("success");
    expect((await api.pipelines.retry("g/p", p.id)).status).toBe("success");
    mock.stop();
  });

  test("a failed job says why, and stops saying so once it runs again or passes", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    const reasons = async () =>
      (await collect(api.pipelines.jobs("g/p", p.id))).map((j) => j.failureReason);
    expect(await reasons()).toEqual([null, null]);

    mock.finishPipeline(p.id, "failed", "runner_system_failure");
    expect(await reasons()).toEqual(["runner_system_failure", "runner_system_failure"]);
    mock.finishPipeline(p.id, "failed");
    expect(await reasons()).toEqual(["script_failure", "script_failure"]);

    await api.pipelines.retry("g/p", p.id);
    expect(await reasons()).toEqual([null, null]);
    mock.finishPipeline(p.id, "failed");
    mock.finishPipeline(p.id, "success");
    expect(await reasons()).toEqual([null, null]);

    mock.finishPipeline(p.id, "failed", "script_failure", ["build"]);
    const jobs = await collect(api.pipelines.jobs("g/p", p.id));
    expect(jobs.map((j) => [j.name, j.status, j.failureReason])).toEqual([
      ["build", "success", null],
      ["test", "failed", "script_failure"],
    ]);
    mock.stop();
  });

  test("a status GitLab adds later reads as unknown instead of failing", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          id: 1,
          iid: 1,
          status: "frobnicating",
          ref: "main",
          sha: "a",
          web_url: "u",
        }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const p = await api.pipelines.get("g/p", 1);
    expect(p.status).toBe("unknown");
    expect(isFinished(p.status)).toBe(false);
    server.stop(true);
  });

  test("a project without a CI file, or with a broken one, cannot start a pipeline", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/none" });
    mock.addProject({ path: "g/broken", files: { ".gitlab-ci.yml": "job:\n  stage: x\n" } });
    expect((await api.pipelines.trigger("g/none", "main").catch((e) => e)).kind).toBe("invalid");
    expect((await api.pipelines.trigger("g/broken", "main").catch((e) => e)).kind).toBe("invalid");
    mock.stop();
  });

  test("lint maps every kind of problem to a result with errors, never a throw", async () => {
    const { mock, api } = ready();
    for (const bad of [
      "",
      "- just\n- a list\n",
      "job: [unclosed\n",
      "job:\n  stage: x\n",
      "stages: [a]\n",
    ]) {
      const r = await api.ci.lint("g/p", bad);
      expect(r.valid).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.mergedYaml).toBeNull();
    }
    expect(await api.ci.lint("g/p", CI)).toMatchObject({ valid: true, errors: [] });
    mock.stop();
  });

  test("lint gives the configured warnings to valid config only", async () => {
    const { mock, api } = ready({ lintWarnings: ["jobs:build may allow multiple pipelines"] });
    expect(await api.ci.lint("g/p", CI)).toMatchObject({
      valid: true,
      warnings: ["jobs:build may allow multiple pipelines"],
    });
    expect((await api.ci.lint("g/p", "job:\n  stage: x\n")).warnings).toEqual([]);
    mock.stop();
  });

  describe("an include of a file in another project", () => {
    const FILE = `spec:
  inputs:
    image:
      default: node:22
      options: [node:22, node:24]
    retries:
      type: number
      default: 2
    stage:
      type: string
---
build:
  image: $[[ inputs.image ]]
  stage: $[[ inputs.stage ]]
  retry: $[[ inputs.retries ]]
  script:
    - echo "on $[[ inputs.image ]]"
`;
    const withTemplates = (files: Record<string, string> = { "t/1/pipeline.yml": FILE }) => {
      const { mock, api } = setup();
      mock.addProject({ path: "g/templates", files });
      const p = mock.addProject({ path: "g/p" });
      return { mock, api, p };
    };
    const include = (extra = "", inputs = "      stage: test\n") =>
      `include:\n  - project: g/templates\n    file: t/1/pipeline.yml\n    inputs:\n${inputs}${extra}`;

    test("lints as the merged pipeline: inputs applied, the main file merged over the included jobs", async () => {
      const { mock, api, p } = withTemplates();
      expect(await api.ci.lint(p.id, include())).toMatchObject({ valid: true, errors: [] });
      // a job of the main file that has no script of its own takes the included one
      expect((await api.ci.lint(p.id, `${include()}build:\n  tags: [big]\n`)).valid).toBe(true);
      expect((await api.ci.lint(p.id, `${include()}other:\n  tags: [big]\n`)).errors).toEqual([
        "jobs:other config should implement the script:, run:, or trigger: keyword",
      ]);
      mock.stop();
    });

    test("says what is wrong with the include, as lint errors", async () => {
      const { mock, api, p } = withTemplates();
      const errors = async (text: string) => (await api.ci.lint(p.id, text)).errors;
      expect(await errors(include().replace("g/templates", "g/nope"))).toEqual([
        "Project `g/nope` not found or access denied! Make sure any includes in the pipeline configuration are correctly defined.",
      ]);
      expect(await errors(include().replace("t/1/", "t/2/"))).toEqual([
        "Project `g/templates` file `/t/2/pipeline.yml` does not exist!",
      ]);
      expect(await errors(include("    ref: gone\n"))).toEqual([
        "Project `g/templates` reference `gone` does not exist!",
      ]);
      expect(await errors(include("", ""))).toEqual([
        "`stage` input: required value has not been provided",
      ]);
      expect(await errors(include("      extra: 1\n"))).toEqual(["unknown input arguments: extra"]);
      expect((await errors(include("      image: node:18\n")))[0]).toContain(
        "not in the list of allowed options",
      );
      expect(await errors(include("      retries: '3'\n"))).toEqual([
        "`retries` input: provided value is not a number",
      ]);
      mock.stop();
    });

    test("a file that uses an input it does not declare is refused", async () => {
      const { mock, api, p } = withTemplates({
        "t/1/pipeline.yml": 'spec:\n  inputs: {}\n---\nbuild:\n  script: ["$[[ inputs.nope ]]"]\n',
      });
      expect((await api.ci.lint(p.id, include("", ""))).errors).toEqual([
        "unknown interpolation key: `nope`",
      ]);
      mock.stop();
    });

    test("the main file wins over the included file, and a leading slash in the path is allowed", async () => {
      const { mock, api } = withTemplates();
      mock.addProject({
        path: "g/thin",
        files: {
          ".gitlab-ci.yml": `${include().replace("file: t/", "file: /t/")}build:\n  stage: deploy\n`,
        },
      });
      const run = await api.pipelines.trigger("g/thin", "main");
      expect(
        (await collect(api.pipelines.jobs("g/thin", run.id))).map((j) => [j.name, j.stage]),
      ).toEqual([["build", "deploy"]]);
      mock.stop();
    });

    test("an include that fails reports its own error and nothing about the main file's jobs", async () => {
      const { mock, api, p } = withTemplates();
      const broken = `${include().replace("t/1/", "t/2/")}build:\n  tags: [big]\n`;
      expect((await api.ci.lint(p.id, broken)).errors).toEqual([
        "Project `g/templates` file `/t/2/pipeline.yml` does not exist!",
      ]);
      mock.stop();
    });

    test("a pipeline of a project whose file only includes runs the included jobs", async () => {
      const { mock, api } = withTemplates();
      mock.addProject({ path: "g/thin", files: { ".gitlab-ci.yml": include() } });
      const run = await api.pipelines.trigger("g/thin", "main");
      expect((await collect(api.pipelines.jobs("g/thin", run.id))).map((j) => j.name)).toEqual([
        "build",
      ]);
      mock.stop();
    });
  });
});

describe("variables", () => {
  const owner = { project: "g/p" };
  const SECRET = "super-secret-value-9";
  const fakeGitlab = (handler: (req: Request) => Response) => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return handler(req);
      },
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    return { api, seen, stop: () => server.stop(true) };
  };

  test("a value is readable but does not show up in JSON, spread or Object.keys", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const v = await api.variables.create(owner, "API_TOKEN", { value: SECRET, masked: true });
    expect(v.value).toBe(SECRET);
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(JSON.stringify({ ...v })).not.toContain(SECRET);
    expect(Object.keys(v)).not.toContain("value");
    expect(Bun.inspect(await collect(api.variables.list(owner)))).not.toContain(SECRET);
    mock.stop();
  });

  test("a hidden variable is masked and its value reads back as null", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const v = await api.variables.create(owner, "HIDDEN_ONE", { value: SECRET, hidden: true });
    expect(v).toMatchObject({ hidden: true, masked: true });
    expect(v.value).toBeNull();
    expect((await api.variables.get(owner, { key: "HIDDEN_ONE" })).value).toBeNull();
    const err = await api.variables
      .create(owner, "HIDDEN_TWO", { value: "short", hidden: true })
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    mock.stop();
  });

  test("group variables live apart from project variables", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("platform");
    mock.addProject({ path: "platform/p" });
    await api.variables.create({ group: group.id }, "SHARED", { value: "group-value-1" });
    expect(await collect(api.variables.list({ project: "platform/p" }))).toEqual([]);
    expect((await api.variables.get({ group: "platform" }, { key: "SHARED" })).value).toBe(
      "group-value-1",
    );
    expect(
      (await api.variables.get({ group: 2_000_000 }, { key: "SHARED" }).catch((e) => e)).kind,
    ).toBe("not_found");
    mock.stop();
  });

  test("lists across pages", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    mock.addProject({ path: "g/p" });
    for (const k of ["A_1", "B_2", "C_3", "D_4", "E_5"]) {
      await api.variables.create(owner, k, { value: "plain" });
    }
    expect((await collect(api.variables.list(owner))).map((v) => v.key)).toEqual([
      "A_1",
      "B_2",
      "C_3",
      "D_4",
      "E_5",
    ]);
    mock.stop();
  });

  test("a bad key is refused before any request", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    for (const key of ["", "has space", "a/b", "a-b", "x".repeat(256), "../x"]) {
      await expect(api.variables.create(owner, key, { value: "v" })).rejects.toThrow(TypeError);
      await expect(api.variables.get(owner, { key })).rejects.toThrow(TypeError);
    }
    expect(mock.requests).toHaveLength(0);
    mock.stop();
  });

  test("an error that echoes a variable value is scrubbed, on create and on update", async () => {
    const f = fakeGitlab((req) =>
      req.method === "GET"
        ? Response.json({
            key: "K",
            value: "old-value-1",
            variable_type: "env_var",
            protected: false,
            masked: false,
            environment_scope: "*",
          })
        : Response.json({ message: `invalid value ${SECRET}` }, { status: 400 }),
    );
    const created = await f.api.variables.create(owner, "K", { value: SECRET }).catch((e) => e);
    const updated = await f.api.variables
      .update(owner, { key: "K" }, { value: SECRET })
      .catch((e) => e);
    for (const err of [created, updated]) {
      expect(err.kind).toBe("invalid");
      expect(err.message).toContain("[REDACTED]");
      expect(err.message).not.toContain(SECRET);
    }
    f.stop();
  });

  test("a lookup answered with another scope stops the write", async () => {
    const f = fakeGitlab(() =>
      Response.json({
        key: "K",
        value: "base",
        variable_type: "env_var",
        protected: false,
        masked: false,
        environment_scope: "*",
      }),
    );
    const ref = { key: "K", scope: "production" };
    expect((await f.api.variables.update(owner, ref, { value: "x" }).catch((e) => e)).kind).toBe(
      "not_found",
    );
    expect((await f.api.variables.delete(owner, ref).catch((e) => e)).kind).toBe("not_found");
    expect(f.seen.every((s) => s.startsWith("GET "))).toBe(true);
    f.stop();
  });

  test("a scope GitLab did not apply is reported, not hidden", async () => {
    const f = fakeGitlab(() =>
      Response.json(
        { key: "K", value: "v", variable_type: "env_var", protected: false, masked: false },
        { status: 201 },
      ),
    );
    const err = await f.api.variables
      .create({ group: 7 }, "K", { value: "v", scope: "production" })
      .catch((e) => e);
    expect(err.kind).toBe("unexpected");
    expect(err.message).toContain("production");
    f.stop();
  });

  test("create sends raw: true unless told otherwise", async () => {
    const sent: unknown[] = [];
    const f = fakeGitlab(() =>
      Response.json(
        { key: "K", value: "v", variable_type: "env_var", protected: false, masked: false },
        { status: 201 },
      ),
    );
    const rawFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return rawFetch(url, init);
    }) as typeof fetch;
    try {
      await f.api.variables.create(owner, "K", { value: "v" });
      await f.api.variables.create(owner, "K", { value: "v", raw: false });
    } finally {
      globalThis.fetch = rawFetch;
      f.stop();
    }
    expect(sent.map((b) => (b as { raw: boolean }).raw)).toEqual([true, false]);
  });

  test("a variable from an older GitLab without raw, hidden or scope fields still decodes", async () => {
    const f = fakeGitlab(() =>
      Response.json({
        key: "K",
        value: "v",
        variable_type: "env_var",
        protected: true,
        masked: false,
      }),
    );
    expect({ ...(await f.api.variables.get(owner, { key: "K" })) }).toEqual({
      key: "K",
      type: "env_var",
      protected: true,
      masked: false,
      hidden: false,
      raw: false,
      scope: "*",
      description: null,
    });
    f.stop();
  });
});

describe("failure injection", () => {
  const started: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const m of started.splice(0)) m.stop();
  });
  const retrying = (maxRetries = 3) => {
    const mock = createMockGitlab();
    started.push(mock);
    const sleeps: number[] = [];
    const api = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    mock.addProject({ path: "g/p" });
    return {
      mock,
      api,
      sleeps,
      hits: () => mock.requests.filter((r) => r.path.endsWith("/g%2Fp")),
    };
  };
  const projectGet = /\/projects\/[^/]+$/;

  test("a 429 waits for Retry-After and then succeeds", async () => {
    const { mock, api, sleeps, hits } = retrying();
    mock.inject({ method: "GET", path: projectGet, status: 429, times: 2, retryAfter: 2 });
    expect((await api.projects.get("g/p")).path).toBe("g/p");
    expect(sleeps).toEqual([2000, 2000]);
    expect(hits()).toHaveLength(3);
  });

  test("a wait beyond the cap fails at once as rate_limited, carrying the wait", async () => {
    const { mock, api, sleeps, hits } = retrying();
    mock.inject({ status: 429, times: 5, retryAfter: 120 });
    const err = await api.projects.get("g/p").catch((e) => e);
    expect(err).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 120_000 });
    expect(sleeps).toEqual([]);
    expect(hits()).toHaveLength(1);
  });

  test("a GET is retried through 500s and gives up after the limit", async () => {
    const ok = retrying();
    ok.mock.inject({ path: projectGet, status: 500, times: 2 });
    expect((await ok.api.projects.get("g/p")).path).toBe("g/p");
    expect(ok.hits()).toHaveLength(3);

    const down = retrying(2);
    down.mock.inject({ path: projectGet, status: 503, times: 99 });
    expect((await down.api.projects.get("g/p").catch((e) => e)).kind).toBe("server");
    expect(down.hits()).toHaveLength(3);
  });

  test("a POST is not retried after a 500, since it may have been applied", async () => {
    const { mock, api } = retrying();
    mock.inject({ method: "POST", status: 500, times: 3 });
    const err = await api.repository.createBranch("g/p", "feature", "main").catch((e) => e);
    expect(err.kind).toBe("server");
    expect(mock.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("an injection only hits what it matches and runs out", async () => {
    const { mock, api } = retrying(0);
    mock.inject({ method: "DELETE", status: 500 });
    mock.inject({ path: "/api/v4/groups", status: 500 });
    expect((await api.projects.get("g/p")).path).toBe("g/p"); // neither matches
    expect((await collect(api.groups.list()).catch((e) => e)).kind).toBe("server");
    expect(await collect(api.groups.list())).toEqual([]); // used up
  });
});

describe("the default-branch guard", () => {
  test("refuses before sending any commit request", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const err = await api.repository
      .commitFiles("g/p", { branch: "main", message: "m" }, [
        { action: "create", path: "x", content: "1" },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitlabError);
    expect(err.kind).toBe("invalid");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
    mock.stop();
  });
});

describe("the default-branch guard, spelling", () => {
  test("also catches a refs/heads/ prefixed default branch", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const err = await api.repository
      .commitFiles("g/p", { branch: "refs/heads/main", message: "m" }, [
        { action: "create", path: "x", content: "1" },
      ])
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
    mock.stop();
  });
});

describe("response validation", () => {
  test("a payload of the wrong shape names the fields, never the values", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({ id: "SECRET-VALUE-77", name: 5, path_with_namespace: "g/p", web_url: "u" }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const err = await api.projects.get(1).catch((e) => e);
    expect(err).toBeInstanceOf(GitlabError);
    expect(err.kind).toBe("unexpected");
    expect(err.message).toContain("id");
    expect(err.message).toContain("name");
    expect(err.message).not.toContain("SECRET-VALUE-77");
    server.stop(true);
  });

  test("encodes a full project path as one path segment", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "group/sub/repo" });
    await api.projects.get("group/sub/repo");
    expect(mock.requests.at(-1)?.path).toBe("/api/v4/projects/group%2Fsub%2Frepo");
    mock.stop();
  });
});

describe("members", () => {
  const level = (
    api: ReturnType<typeof setup>["api"],
    of: Parameters<ReturnType<typeof setup>["api"]["members"]["accessLevel"]>[0],
    user: number,
  ) => api.members.accessLevel(of, user);

  test("a direct membership is its level; a non-member is 0", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    const project = mock.addProject({ path: "acme/web" });
    mock.addMember({ group: group.id }, 11, 30);
    mock.addMember({ project: project.id }, 12, 20);
    expect(await level(api, { group: group.id }, 11)).toBe(30);
    expect(await level(api, { group: "acme" }, 11)).toBe(30);
    expect(await level(api, { project: project.id }, 12)).toBe(20);
    expect(await level(api, { project: "acme/web" }, 12)).toBe(20);
    expect(await level(api, { group: group.id }, 12)).toBe(0);
    expect(await level(api, { project: project.id }, 99)).toBe(0);
    mock.stop();
  });

  test("a project inherits the best level from its ancestor groups, nested ones included", async () => {
    const { mock, api } = setup();
    const top = mock.addGroup("acme");
    const sub = mock.addGroup("acme/platform");
    mock.addGroup("acmeish"); // a name that merely starts the same is no ancestor
    const project = mock.addProject({ path: "acme/platform/api" });
    const other = mock.addProject({ path: "acmeish/web" });
    mock.addMember({ group: top.id }, 21, 20);
    mock.addMember({ group: sub.id }, 22, 40);
    mock.addMember({ group: top.id }, 23, 50);
    mock.addMember({ project: project.id }, 23, 30);
    expect(await level(api, { project: project.id }, 21)).toBe(20);
    expect(await level(api, { group: sub.id }, 21)).toBe(20);
    expect(await level(api, { project: project.id }, 22)).toBe(40);
    expect(await level(api, { group: top.id }, 22)).toBe(0); // downwards only
    expect(await level(api, { project: project.id }, 23)).toBe(50); // the better of the two
    expect(await level(api, { project: other.id }, 21)).toBe(0);
    mock.removeMember({ group: top.id }, 21);
    expect(await level(api, { project: project.id }, 21)).toBe(0);
    mock.stop();
  });

  test("an invite awaiting approval, or a blocked account, holds nothing", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addUser({ id: 31, username: "ann", name: "Ann" });
    mock.addUser({ id: 32, username: "bob", name: "Bob", state: "blocked" });
    mock.addUser({ id: 33, username: "cy", name: "Cy", state: "deactivated" });
    mock.addMember({ group: group.id }, 31, 40);
    mock.addMember({ group: group.id }, 32, 40);
    mock.addMember({ group: group.id }, 33, 40);
    mock.addMember({ group: group.id }, 34, 40, "awaiting");
    expect(await level(api, { group: group.id }, 31)).toBe(40);
    expect(await level(api, { group: group.id }, 32)).toBe(0);
    expect(await level(api, { group: group.id }, 33)).toBe(0);
    expect(await level(api, { group: group.id }, 34)).toBe(0);
    mock.stop();
  });

  test("an answer that does not say the account is active grants nothing", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addMember({ group: group.id }, 41, 40);
    const real = globalThis.fetch;
    // GitLab leaving `state` out must not read as "active".
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/members/all/"))
        return res;
      const { state: _state, ...rest } = (await res.json()) as Record<string, unknown>;
      return Response.json(rest);
    }) as typeof fetch;
    try {
      expect(await level(api, { group: group.id }, 41)).toBe(0);
    } finally {
      globalThis.fetch = real;
      mock.stop();
    }
  });

  test("a lookup that fails is an error, never 'no access'", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addMember({ group: group.id }, 51, 40);
    for (const [status, kind] of [
      [500, "server"],
      [403, "forbidden"],
      [401, "unauthorized"],
      [429, "rate_limited"],
    ] as const) {
      mock.inject({ path: /members\/all/, status });
      const error = await level(api, { group: group.id }, 51).catch((e) => e);
      expect(error).toBeInstanceOf(GitlabError);
      expect((error as GitlabError).kind).toBe(kind);
    }
    expect(await level(api, { group: group.id }, 51)).toBe(40);
    mock.stop();
  });

  test("a malformed answer is an error", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addMember({ group: group.id }, 61, 40);
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/members/all/"))
        return res;
      return Response.json({ access_level: "40", state: "active" });
    }) as typeof fetch;
    try {
      await expect(level(api, { group: group.id }, 61)).rejects.toThrow(GitlabError);
    } finally {
      globalThis.fetch = real;
      mock.stop();
    }
  });

  test("the token reports its scopes and expiry", async () => {
    const { mock, api } = setup({
      scopes: ["read_api", "read_user"],
      tokenExpiresAt: "2027-01-31",
    });
    expect(await api.users.tokenInfo()).toEqual({
      scopes: ["read_api", "read_user"],
      expiresAt: "2027-01-31",
    });
    mock.stop();
    const open = setup();
    expect(await open.api.users.tokenInfo()).toEqual({ scopes: ["api"], expiresAt: null });
    open.mock.stop();
  });

  test("the token's own user comes from /user", async () => {
    const { mock, api } = setup();
    expect(await api.users.current()).toEqual({
      gitlabId: mock.tokenUser.id,
      username: "mock-token-user",
      name: "Mock token user",
      active: true,
    });
    mock.stop();
  });
});
