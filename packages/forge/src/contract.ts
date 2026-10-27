import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  canMask,
  GitlabError,
  type GitlabErrorKind,
  type ProjectRef,
  type VariableOwner,
  type VariableRef,
} from "@orch/gitlab";
import type { Forge } from "./index";

/**
 * The behaviour every forge must show. For GitLab it runs against the in-process mock by default
 * (`gitlab.mock.contract.test.ts`) and against a real sandbox group when opted in (GL-5), so the mock can
 * only say what a real GitLab says. Everything it writes lands on branches named `orch-contract-*`
 * of the project it is given, never on the default branch. A case for something the forge reports it cannot do
 * (`capabilities`) is not run for it; that the forge then refuses with a message is the adapter's own test.
 * shortcut: only the cases of `ciLint`, `tokenScopes`, `accessTokens`, `runners` and `deployments` check their flag;
 * the other nine run for every forge until one reports them false (FRG-10).
 */
export interface ContractTarget {
  forge: Forge;
  /** A project the token can write to, with a default branch and at least one commit. */
  project: ProjectRef;
  /** A group the token belongs to. */
  group: { id: number; path: string };
}

async function failsWith(kind: GitlabErrorKind, p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitlabError);
    expect((e as GitlabError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a ${kind} error`);
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

/** The groups of cases, named as they are in the test output. */
export const CONTRACT_AREAS = [
  "projects",
  "repository",
  "pipelines and CI lint",
  "variables",
  "project access tokens",
  "the token",
  "runners",
  "deployments and environments",
  "instance",
  "members",
  "merge requests",
] as const;
export type ContractArea = (typeof CONTRACT_AREAS)[number];

/**
 * `areas` limits the run to the groups a forge has built so far (default: all). `projects` is read by every run:
 * the default branch comes from it.
 */
export function forgeContract(
  label: string,
  setup: () => Promise<{ target: ContractTarget; stop: () => void | Promise<void> }>,
  opts: { areas?: readonly ContractArea[] } = {},
) {
  const area = (name: ContractArea, cases: () => void) => {
    if (!opts.areas || opts.areas.includes(name)) describe(name, cases);
  };
  describe(`Forge contract: ${label}`, () => {
    let t: ContractTarget;
    let stop: () => void | Promise<void>;
    let defaultBranch: string;
    beforeAll(async () => {
      ({ target: t, stop } = await setup());
      defaultBranch = (await t.forge.projects.get(t.project)).defaultBranch ?? "";
    });
    // Branches made here are removed at the end, so a real sandbox is left as it was found.
    const branches: string[] = [];
    afterAll(async () => {
      if (!t) return; // setup failed: that error is the one to read
      const left: unknown[] = [];
      try {
        for (const name of branches) {
          await t.forge.repository.deleteBranch(t.project, name).catch((e) => {
            if (!(e instanceof GitlabError && e.kind === "not_found")) left.push(e);
          });
        }
      } finally {
        await stop();
      }
      if (left.length) throw new AggregateError(left, "contract branches could not be removed");
    });

    const newBranch = async () => {
      const name = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
      branches.push(name);
      await t.forge.repository.createBranch(t.project, name, defaultBranch);
      return name;
    };

    area("projects", () => {
      test("lists visible projects as domain objects, in id order", async () => {
        const all = await collect(t.forge.projects.list());
        const mine = await t.forge.projects.get(t.project);
        expect(all.find((p) => p.id === mine.id)).toEqual(mine);
        expect(all.map((p) => p.id)).toEqual(all.map((p) => p.id).sort((a, b) => a - b));
        expect(typeof mine.path).toBe("string");
        expect(mine.defaultBranch).toBeTruthy();
      });

      test("gets a project by id and by full path; an unknown one is not_found", async () => {
        const byRef = await t.forge.projects.get(t.project);
        expect(await t.forge.projects.get(byRef.id)).toEqual(byRef);
        expect(await t.forge.projects.get(byRef.path)).toEqual(byRef);
        await failsWith("not_found", t.forge.projects.get(2_000_000_000));
      });
    });

    area("repository", () => {
      test("creates a branch; creating it again is invalid", async () => {
        const name = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
        branches.push(name);
        const b = await t.forge.repository.createBranch(t.project, name, defaultBranch);
        expect(b).toMatchObject({ name, default: false });
        expect(b.commitId).toMatch(/^[0-9a-f]{40}$/);
        await failsWith("invalid", t.forge.repository.createBranch(t.project, name, defaultBranch));
        await failsWith(
          "invalid",
          t.forge.repository.createBranch(t.project, `${name}-x`, "no-such-ref-orch"),
        );
      });

      test("gets a branch; one that is not there is not_found", async () => {
        const name = await newBranch();
        expect(await t.forge.repository.getBranch(t.project, name)).toMatchObject({
          name,
          default: false,
        });
        expect(await t.forge.repository.getBranch(t.project, defaultBranch)).toMatchObject({
          name: defaultBranch,
          default: true,
        });
        await failsWith("not_found", t.forge.repository.getBranch(t.project, `${name}-none`));
      });

      test("lists tags as a name and a commit (a sandbox may have none); an unknown project is not_found", async () => {
        const tags = await collect(t.forge.repository.tags(t.project));
        for (const tag of tags) {
          expect(tag.name.length).toBeGreaterThan(0);
          expect(tag.commitId).toMatch(/^[0-9a-f]{40}$/);
        }
        await failsWith("not_found", collect(t.forge.repository.tags(`${t.project}-none`)));
      });

      test("commits several files at once and reads them back, tree and content", async () => {
        const branch = await newBranch();
        const root = `orch-contract/${branch}`;
        const commit = await t.forge.repository.commitFiles(
          t.project,
          { branch, message: "contract: add files" },
          [
            { action: "create", path: `${root}/a.txt`, content: "héllo wörld\n" },
            { action: "create", path: `${root}/dir/b.json`, content: '{"k":1}' },
          ],
        );
        expect(commit.id).toMatch(/^[0-9a-f]{40}$/);

        const file = await t.forge.repository.getFile(t.project, `${root}/a.txt`, branch);
        expect(file.content).toBe("héllo wörld\n");
        expect(file.path).toBe(`${root}/a.txt`);

        const all = await collect(t.forge.repository.tree(t.project, { ref: branch, path: root }));
        expect(all.map((e) => `${e.type}:${e.path}`).sort()).toEqual([
          `blob:${root}/a.txt`,
          `blob:${root}/dir/b.json`,
          `tree:${root}/dir`,
        ]);
        const top = await collect(
          t.forge.repository.tree(t.project, { ref: branch, path: root, recursive: false }),
        );
        expect(top.map((e) => e.path).sort()).toEqual([`${root}/a.txt`, `${root}/dir`]);
      });

      test("compare reports added, modified and deleted files", async () => {
        const branch = await newBranch();
        const dir = `orch-contract/${branch}`;
        await t.forge.repository.commitFiles(t.project, { branch, message: "contract: add" }, [
          { action: "create", path: `${dir}/keep.txt`, content: "1" },
          { action: "create", path: `${dir}/gone.txt`, content: "1" },
        ]);
        const base = `${branch}-base`;
        branches.push(base);
        await t.forge.repository.createBranch(t.project, base, branch);
        await t.forge.repository.commitFiles(t.project, { branch, message: "contract: change" }, [
          { action: "update", path: `${dir}/keep.txt`, content: "2" },
          { action: "delete", path: `${dir}/gone.txt` },
          { action: "create", path: `${dir}/new.txt`, content: "3" },
        ]);
        const cmp = await t.forge.repository.compare(t.project, base, branch);
        expect(cmp.timedOut).toBe(false);
        expect(cmp.files.map((f) => `${f.status}:${f.newPath}`).sort()).toEqual([
          `added:${dir}/new.txt`,
          `deleted:${dir}/gone.txt`,
          `modified:${dir}/keep.txt`,
        ]);

        const same = await t.forge.repository.compare(t.project, branch, branch);
        expect(same.sameRef).toBe(true);
        expect(same.files).toEqual([]);

        expect(
          (await t.forge.repository.getFile(t.project, `${dir}/keep.txt`, branch)).content,
        ).toBe("2");
        await failsWith(
          "not_found",
          t.forge.repository.getFile(t.project, `${dir}/gone.txt`, branch),
        );
      });

      test("a commit that contradicts the branch is invalid and applies nothing", async () => {
        const branch = await newBranch();
        const path = `orch-contract/${branch}/x.txt`;
        await t.forge.repository.commitFiles(t.project, { branch, message: "contract: x" }, [
          { action: "create", path, content: "1" },
        ]);
        await failsWith(
          "invalid",
          t.forge.repository.commitFiles(t.project, { branch, message: "contract: dup" }, [
            { action: "create", path: `${path}.other`, content: "1" },
            { action: "create", path, content: "again" },
          ]),
        );
        await failsWith(
          "not_found",
          t.forge.repository.getFile(t.project, `${path}.other`, branch),
        );
        await failsWith(
          "invalid",
          t.forge.repository.commitFiles(t.project, { branch, message: "contract: upd" }, [
            { action: "update", path: `${path}.missing`, content: "1" },
          ]),
        );
      });

      test("never commits to the default branch", async () => {
        const path = `orch-contract/default-${Bun.randomUUIDv7().slice(-8)}.txt`;
        await failsWith(
          "invalid",
          t.forge.repository.commitFiles(t.project, { branch: defaultBranch, message: "no" }, [
            { action: "create", path, content: "1" },
          ]),
        );
        await failsWith("not_found", t.forge.repository.getFile(t.project, path, defaultBranch));
      });

      test("startBranch only works for a branch that does not exist yet", async () => {
        const branch = await newBranch();
        await failsWith(
          "invalid",
          t.forge.repository.commitFiles(
            t.project,
            { branch, startBranch: defaultBranch, message: "contract: exists" },
            [{ action: "create", path: `orch-contract/${branch}/e.txt`, content: "1" }],
          ),
        );
      });

      test("deletes a branch, once; the default branch is never deleted", async () => {
        const name = await newBranch();
        await t.forge.repository.deleteBranch(t.project, name);
        await failsWith("not_found", t.forge.repository.deleteBranch(t.project, name));
        await failsWith("invalid", t.forge.repository.deleteBranch(t.project, defaultBranch));
        expect((await t.forge.projects.get(t.project)).defaultBranch).toBe(defaultBranch);
        await t.forge.repository.createBranch(t.project, name, defaultBranch); // the name is free again
      });

      test("commitFiles can start a new branch from another", async () => {
        const branch = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
        branches.push(branch);
        const path = `orch-contract/${branch}/s.txt`;
        await t.forge.repository.commitFiles(
          t.project,
          { branch, startBranch: defaultBranch, message: "contract: start" },
          [{ action: "create", path, content: "s" }],
        );
        expect((await t.forge.repository.getFile(t.project, path, branch)).content).toBe("s");
      });
    });

    area("pipelines and CI lint", () => {
      // Manual jobs: the pipeline exists but no runner picks anything up.
      const CI = 'contract:\n  stage: test\n  when: manual\n  script:\n    - "true"\n';
      const ciBranch = async () => {
        const branch = await newBranch();
        const commit = await t.forge.repository.commitFiles(
          t.project,
          { branch, message: "contract: ci" },
          [{ action: "create", path: ".gitlab-ci.yml", content: CI }],
        );
        return { branch, sha: commit.id };
      };

      test("triggers a pipeline with variables, reads it and its jobs, cancels and retries it", async () => {
        const { branch, sha } = await ciBranch();
        const p = await t.forge.pipelines.trigger(t.project, branch, [
          { key: "CONTRACT_VAR", value: "contract-secret-value-1" },
        ]);
        expect(p).toMatchObject({ ref: branch, sha });
        expect(p.status).not.toBe("unknown");
        expect(JSON.stringify(p)).not.toContain("contract-secret-value-1");

        expect(await t.forge.pipelines.get(t.project, p.id)).toMatchObject({
          id: p.id,
          ref: branch,
        });
        const jobs = await collect(t.forge.pipelines.jobs(t.project, p.id));
        expect(jobs.map((j) => `${j.stage}:${j.name}`)).toEqual(["test:contract"]);
        // a manual job that nobody played has not started: no time and no duration, never a made-up one
        expect(jobs.map((j) => [j.startedAt, j.finishedAt, j.duration])).toEqual([
          [null, null, null],
        ]);
        // a job that has made no artifacts has no such file: missing, not an error
        const jobId = jobs[0]?.id ?? 0;
        expect(
          await t.forge.pipelines.artifact(t.project, jobId, "gl-contract-report.json", 1000),
        ).toEqual({
          status: "missing",
        });

        expect((await t.forge.pipelines.cancel(t.project, p.id)).id).toBe(p.id);
        expect((await t.forge.pipelines.retry(t.project, p.id)).id).toBe(p.id);
        await t.forge.pipelines.cancel(t.project, p.id);
      });

      test("an unknown ref is invalid, an unknown pipeline is not_found", async () => {
        await failsWith("invalid", t.forge.pipelines.trigger(t.project, "orch-no-such-ref"));
        await failsWith("not_found", t.forge.pipelines.get(t.project, 2_000_000_000));
      });

      test("lint reports valid config, and errors as a result rather than an exception", async () => {
        if (!t.forge.capabilities.ciLint) return;
        const ok = await t.forge.ci.lint(t.project, CI);
        expect(ok).toMatchObject({ valid: true, errors: [] });
        expect(ok.mergedYaml).toContain("contract");

        const noScript = await t.forge.ci.lint(t.project, "contract:\n  stage: test\n");
        expect(noScript.valid).toBe(false);
        expect(noScript.errors.join("\n")).toContain("contract");
        expect(noScript.mergedYaml).toBeNull();

        const broken = await t.forge.ci.lint(t.project, "contract: [unclosed\n");
        expect(broken.valid).toBe(false);
        expect(broken.errors.length).toBeGreaterThan(0);
      });
    });

    area("variables", () => {
      // Every variable made here is removed again, also when the test fails.
      const made: { owner: VariableOwner; ref: VariableRef }[] = [];
      afterEach(async () => {
        const left: unknown[] = [];
        for (const { owner, ref } of made.splice(0)) {
          await t.forge.variables.delete(owner, ref).catch((e) => {
            if (!(e instanceof GitlabError && e.kind === "not_found")) left.push(e);
          });
        }
        if (left.length) throw new AggregateError(left, "contract variables could not be removed");
      });
      const projectOwner = (): VariableOwner => ({ project: t.project });
      const newKey = () => `ORCH_CONTRACT_${Bun.randomUUIDv7().slice(-12).replaceAll("-", "")}`;
      const make = async (
        owner: VariableOwner,
        key: string,
        input: Parameters<Forge["variables"]["create"]>[2],
      ) => {
        made.push({ owner, ref: { key, scope: input.scope } });
        return t.forge.variables.create(owner, key, input);
      };
      const owners: [string, () => VariableOwner][] = [
        ["project", () => ({ project: t.project })],
        ["group", () => ({ group: t.group.id })],
      ];

      for (const [name, ownerOf] of owners) {
        test(`${name}: creates, lists, reads, updates and deletes a variable`, async () => {
          const o = ownerOf();
          const key = newKey();
          const created = await make(o, key, {
            value: "contract-value-1",
            masked: true,
            raw: true,
            description: "contract",
          });
          expect(created).toMatchObject({
            key,
            type: "env_var",
            masked: true,
            protected: false,
            raw: true,
            hidden: false,
            scope: "*",
            description: "contract",
          });
          expect(created.value).toBe("contract-value-1");
          expect(JSON.stringify(created)).not.toContain("contract-value-1");

          const listed = (await collect(t.forge.variables.list(o))).find((v) => v.key === key);
          expect(listed?.value).toBe("contract-value-1");
          await failsWith(
            "invalid",
            t.forge.variables.create(o, key, { value: "contract-value-1" }),
          );

          const updated = await t.forge.variables.update(
            o,
            { key },
            { value: "contract-value-2", protected: true, masked: true, raw: true },
          );
          expect(updated).toMatchObject({ key, protected: true, scope: "*" });
          expect((await t.forge.variables.get(o, { key })).value).toBe("contract-value-2");

          await t.forge.variables.delete(o, { key });
          await failsWith("not_found", t.forge.variables.get(o, { key }));
          await failsWith("not_found", t.forge.variables.delete(o, { key }));
        });
      }

      test("scope-qualified update and delete touch only that scope, a missing scope is not_found", async () => {
        const o = projectOwner();
        const key = newKey();
        const scope = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
        await make(o, key, { value: "base-value-1" });
        await make(o, key, { value: "scoped-value-1", scope, type: "file" });

        const both = (await collect(t.forge.variables.list(o))).filter((v) => v.key === key);
        expect(both.map((v) => v.scope).sort()).toEqual(["*", scope].sort());
        expect((await t.forge.variables.get(o, { key, scope })).type).toBe("file");

        await t.forge.variables.update(
          o,
          { key, scope },
          { value: "scoped-value-2", type: "file" },
        );
        expect((await t.forge.variables.get(o, { key, scope })).value).toBe("scoped-value-2");
        expect((await t.forge.variables.get(o, { key })).value).toBe("base-value-1");

        // A scope that does not exist must not fall through to the variable that does.
        const ghost = { key, scope: "orch-contract-ghost" };
        await failsWith("not_found", t.forge.variables.update(o, ghost, { value: "clobbered-1" }));
        await failsWith("not_found", t.forge.variables.delete(o, ghost));
        expect((await t.forge.variables.get(o, { key })).value).toBe("base-value-1");
        expect((await t.forge.variables.get(o, { key, scope })).value).toBe("scoped-value-2");

        const moved = `${scope}-moved`;
        made.push({ owner: o, ref: { key, scope: moved } });
        await t.forge.variables.update(
          o,
          { key, scope },
          { value: "scoped-value-2", scope: moved },
        );
        await failsWith("not_found", t.forge.variables.get(o, { key, scope }));
        expect((await t.forge.variables.get(o, { key, scope: moved })).value).toBe(
          "scoped-value-2",
        );

        await t.forge.variables.delete(o, { key, scope: moved });
        await failsWith("not_found", t.forge.variables.get(o, { key, scope: moved }));
        expect((await t.forge.variables.get(o, { key })).value).toBe("base-value-1");
        await t.forge.variables.delete(o, { key });
      });

      test("canMask agrees with what the target accepts for a masked variable", async () => {
        const o = projectOwner();
        const table: [string, boolean, boolean][] = [
          ["abcd1234", true, true],
          ["abcd123", true, false],
          ["has space in it", true, false],
          ["line-one\nline-two", true, false],
          ["pa$$w0rd%^&*", true, true],
          ["abc_:@-+.~=/12", false, true],
          ["abcd$efgh1", false, false],
          ["abcd%efgh1", false, false],
          ["abcd efgh1", false, false],
        ];
        for (const [value, raw, ok] of table) {
          expect(canMask(value, { raw })).toBe(ok);
          const key = newKey();
          const accepted = await make(o, key, { value, masked: true, raw }).then(
            () => true,
            (e) => (e instanceof GitlabError && e.kind === "invalid" ? false : Promise.reject(e)),
          );
          expect(accepted).toBe(ok);
        }
      });
    });

    area("project access tokens", () => {
      // Every token made or rotated here is revoked at the end, so a real sandbox is left as it was found.
      const made: number[] = [];
      afterAll(async () => {
        if (!t) return;
        const left: unknown[] = [];
        for (const id of made) {
          await t.forge.accessTokens.revoke(t.project, id).catch((e) => {
            if (!(e instanceof GitlabError && e.kind === "not_found")) left.push(e);
          });
        }
        if (left.length) throw new AggregateError(left, "contract tokens could not be revoked");
      });
      const week = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const make = async () => {
        const token = await t.forge.accessTokens.create(t.project, {
          name: `orch-contract-${Bun.randomUUIDv7().slice(-12)}`,
          scopes: ["read_api"],
          accessLevel: 10,
          expiresAt: week(),
        });
        made.push(token.id);
        return token;
      };

      test("creates a token whose secret is shown once; reading it back does not show it", async () => {
        if (!t.forge.capabilities.accessTokens) return;
        const created = await make();
        expect(created.token).toMatch(/\S{8,}/);
        expect(created).toMatchObject({ scopes: ["read_api"], active: true, revoked: false });
        const read = await t.forge.accessTokens.get(t.project, created.id);
        expect(read).toMatchObject({ id: created.id, name: created.name, active: true });
        expect(read.token).toBeNull();
        // neither JSON nor a log line carries the secret
        expect(JSON.stringify(created)).not.toContain(created.token as string);
      });

      test("rotating gives a new token with the same name and scopes and ends the old one at once", async () => {
        if (!t.forge.capabilities.accessTokens) return;
        const old = await make();
        const next = await t.forge.accessTokens.rotate(t.project, old.id, { expiresAt: week() });
        made.push(next.id);
        expect(next.id).not.toBe(old.id);
        expect(next.token).toMatch(/\S{8,}/);
        expect(next.token).not.toBe(old.token);
        expect(next).toMatchObject({ name: old.name, scopes: old.scopes, active: true });
        expect(await t.forge.accessTokens.get(t.project, old.id)).toMatchObject({ active: false });
        expect(await t.forge.accessTokens.get(t.project, next.id)).toMatchObject({ active: true });
      });

      test("revoking ends a token; one that is not there is not_found for every call", async () => {
        if (!t.forge.capabilities.accessTokens) return;
        const token = await make();
        await t.forge.accessTokens.revoke(t.project, token.id);
        expect(await t.forge.accessTokens.get(t.project, token.id)).toMatchObject({
          active: false,
        });
        const none = 2_000_000_000;
        await failsWith("not_found", t.forge.accessTokens.get(t.project, none));
        await failsWith("not_found", t.forge.accessTokens.rotate(t.project, none));
        await failsWith("not_found", t.forge.accessTokens.revoke(t.project, none));
      });

      test("an id that is not a token id is refused before anything is sent", async () => {
        if (!t.forge.capabilities.accessTokens) return;
        for (const id of [0, -1, 1.5, Number.NaN]) {
          await expect(t.forge.accessTokens.get(t.project, id)).rejects.toBeInstanceOf(TypeError);
        }
      });
    });

    area("the token", () => {
      test("reports its scopes and expiry", async () => {
        if (!t.forge.capabilities.tokenScopes) return;
        const info = await t.forge.users.tokenInfo();
        expect(info.scopes.length).toBeGreaterThan(0);
        expect(info.expiresAt === null || /^\d{4}-\d{2}-\d{2}/.test(info.expiresAt)).toBe(true);
      });
    });

    area("runners", () => {
      test("lists a project's runners as domain objects (a sandbox may have none, or the token may not be a maintainer); an unknown project is not_found", async () => {
        if (!t.forge.capabilities.runners) return;
        const listed = await collect(t.forge.runners.list(t.project)).catch((e) => {
          expect(e).toBeInstanceOf(GitlabError);
          expect((e as GitlabError).kind).toBe("forbidden");
          return [];
        });
        for (const r of listed) {
          expect(Number.isInteger(r.id)).toBe(true);
          expect(typeof r.online).toBe("boolean");
          expect(typeof r.paused).toBe("boolean");
          expect(Object.keys(r).sort()).toEqual(["id", "online", "paused", "status", "type"]);
        }
        await failsWith("not_found", collect(t.forge.runners.list("no-such-group/none")));
      });
    });

    area("deployments and environments", () => {
      test("list as domain objects (a sandbox may have none); an unknown deployment and an unknown project are not_found", async () => {
        if (!t.forge.capabilities.deployments) return;
        for (const d of await collect(t.forge.deployments.list(t.project))) {
          expect(Number.isInteger(d.id)).toBe(true);
          expect(typeof d.environment).toBe("string");
          expect(d.sha).toMatch(/^[0-9a-f]{40}$/);
          expect(d.jobId === null || Number.isInteger(d.jobId)).toBe(true);
          expect(Object.keys(d).sort()).toEqual([
            "createdAt",
            "environment",
            "finishedAt",
            "id",
            "iid",
            "jobId",
            "pipelineId",
            "pipelineUrl",
            "ref",
            "sha",
            "status",
            "updatedAt",
          ]);
        }
        for (const e of await collect(t.forge.environments.list(t.project))) {
          expect(Object.keys(e).sort()).toEqual(["id", "name", "slug", "state"]);
        }
        await failsWith("not_found", t.forge.deployments.get(t.project, 2_000_000_000));
        await failsWith("not_found", collect(t.forge.deployments.list("no-such-group/none")));
        await failsWith("not_found", collect(t.forge.environments.list("no-such-group/none")));
      });
    });

    area("instance", () => {
      test("says which release and edition this is", async () => {
        const i = await t.forge.instance.info();
        expect(Object.keys(i).sort()).toEqual(["enterprise", "major", "minor", "version"]);
        expect(i.version).toMatch(/^\d+\.\d+\./);
        expect([typeof i.major, typeof i.minor, typeof i.enterprise]).toEqual([
          "number",
          "number",
          "boolean",
        ]);
      });
    });

    area("members", () => {
      test("the token's user is an active member of the project and the group", async () => {
        const me = await t.forge.users.current();
        expect(me.active).toBe(true);
        // The project is one the token writes to: Developer or better.
        expect(
          await t.forge.members.accessLevel({ project: t.project }, me.gitlabId),
        ).toBeGreaterThanOrEqual(30);
        expect(
          await t.forge.members.accessLevel({ group: t.group.id }, me.gitlabId),
        ).toBeGreaterThan(0);
        expect(
          await t.forge.members.accessLevel({ group: t.group.path }, me.gitlabId),
        ).toBeGreaterThan(0);
      });

      test("a user who is not a member, and a project or group that is not there, hold nothing", async () => {
        const nobody = 2_000_000_000;
        expect(await t.forge.members.accessLevel({ project: t.project }, nobody)).toBe(0);
        expect(await t.forge.members.accessLevel({ group: t.group.id }, nobody)).toBe(0);
        const me = await t.forge.users.current();
        expect(
          await t.forge.members.accessLevel({ project: "no-such-group/none" }, me.gitlabId),
        ).toBe(0);
        expect(
          await t.forge.members.accessLevel({ group: "no-such-group-orch" }, me.gitlabId),
        ).toBe(0);
      });
    });

    area("merge requests", () => {
      test("opens, reads, edits, closes and reopens a merge request; one open MR per branch", async () => {
        const branch = await newBranch();
        const commit = await t.forge.repository.commitFiles(
          t.project,
          { branch, message: "contract: mr" },
          [{ action: "create", path: `orch-contract/${branch}/mr.txt`, content: "1" }],
        );
        const mr = await t.forge.mergeRequests.create(t.project, {
          sourceBranch: branch,
          targetBranch: defaultBranch,
          title: "contract: open",
          description: "made by the contract suite",
        });
        expect(mr).toMatchObject({
          state: "opened",
          sourceBranch: branch,
          targetBranch: defaultBranch,
          title: "contract: open",
          description: "made by the contract suite",
          sha: commit.id,
        });

        await failsWith(
          "conflict",
          t.forge.mergeRequests.create(t.project, {
            sourceBranch: branch,
            targetBranch: defaultBranch,
            title: "contract: again",
          }),
        );
        await failsWith(
          "invalid",
          t.forge.mergeRequests.create(t.project, {
            sourceBranch: branch,
            targetBranch: branch,
            title: "contract: same",
          }),
        );

        expect(await t.forge.mergeRequests.get(t.project, mr.iid)).toEqual(mr);
        const edited = await t.forge.mergeRequests.update(t.project, mr.iid, {
          title: "contract: edited",
          description: "new text",
        });
        expect(edited).toMatchObject({
          iid: mr.iid,
          title: "contract: edited",
          description: "new text",
        });

        const closed = await t.forge.mergeRequests.update(t.project, mr.iid, { state: "closed" });
        expect(closed.state).toBe("closed");
        const reopened = await t.forge.mergeRequests.update(t.project, mr.iid, { state: "opened" });
        expect(reopened.state).toBe("opened");

        await t.forge.mergeRequests.update(t.project, mr.iid, { state: "closed" });
        await failsWith("not_found", t.forge.mergeRequests.get(t.project, 2_000_000_000));
      });

      test("lists the merge requests of a source branch by state", async () => {
        const branch = await newBranch();
        await t.forge.repository.commitFiles(t.project, { branch, message: "contract: list" }, [
          { action: "create", path: `orch-contract/${branch}/l.txt`, content: "1" },
        ]);
        const where = { sourceBranch: branch, targetBranch: defaultBranch };
        expect(await collect(t.forge.mergeRequests.list(t.project, where))).toEqual([]);
        const mr = await t.forge.mergeRequests.create(t.project, {
          ...where,
          title: "contract: list",
        });
        const opened = await collect(
          t.forge.mergeRequests.list(t.project, { ...where, state: "opened" }),
        );
        expect(opened.map((m) => m.iid)).toEqual([mr.iid]);
        await t.forge.mergeRequests.update(t.project, mr.iid, { state: "closed" });
        expect(
          await collect(t.forge.mergeRequests.list(t.project, { ...where, state: "opened" })),
        ).toEqual([]);
        expect(
          (await collect(t.forge.mergeRequests.list(t.project, where))).map((m) => m.iid),
        ).toEqual([mr.iid]);
      });

      test("creates and edits a note", async () => {
        const branch = await newBranch();
        await t.forge.repository.commitFiles(t.project, { branch, message: "contract: note" }, [
          { action: "create", path: `orch-contract/${branch}/n.txt`, content: "1" },
        ]);
        const mr = await t.forge.mergeRequests.create(t.project, {
          sourceBranch: branch,
          targetBranch: defaultBranch,
          title: "contract: notes",
        });
        const note = await t.forge.mergeRequests.createNote(t.project, mr.iid, "first");
        expect(note).toMatchObject({ body: "first", system: false });
        const edited = await t.forge.mergeRequests.updateNote(t.project, mr.iid, note.id, "second");
        expect(edited).toMatchObject({ id: note.id, body: "second" });
        const read = await t.forge.mergeRequests.getNote(t.project, mr.iid, note.id);
        expect(read).toMatchObject({ id: note.id, body: "second", system: false });
        expect(typeof read.authorId).toBe("number");
        await t.forge.mergeRequests.update(t.project, mr.iid, { state: "closed" });
      });
    });
  });
}
