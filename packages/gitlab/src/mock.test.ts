import { describe, expect, test } from "bun:test";
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
  const ready = () => {
    const s = setup();
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
