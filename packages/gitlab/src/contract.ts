import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  canMask,
  type Gitlab,
  GitlabError,
  type GitlabErrorKind,
  type ProjectRef,
  type VariableOwner,
  type VariableRef,
} from "./index";

/**
 * The behaviour every GitLab target must show. It runs against the in-process mock by default
 * (`mock.contract.test.ts`) and against a real sandbox group when opted in (GL-5), so the mock can
 * only say what a real GitLab says. Everything it writes lands on branches named `orch-contract-*`
 * of the project it is given, never on the default branch.
 */
export interface ContractTarget {
  api: Gitlab;
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

export function gitlabContract(
  label: string,
  setup: () => Promise<{ target: ContractTarget; stop: () => void | Promise<void> }>,
) {
  describe(`GitLab contract: ${label}`, () => {
    let t: ContractTarget;
    let stop: () => void | Promise<void>;
    let defaultBranch: string;
    beforeAll(async () => {
      ({ target: t, stop } = await setup());
      defaultBranch = (await t.api.projects.get(t.project)).defaultBranch ?? "";
    });
    // Branches made here are removed at the end, so a real sandbox is left as it was found.
    const branches: string[] = [];
    afterAll(async () => {
      if (!t) return; // setup failed: that error is the one to read
      const left: unknown[] = [];
      try {
        for (const name of branches) {
          await t.api.repository.deleteBranch(t.project, name).catch((e) => {
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
      await t.api.repository.createBranch(t.project, name, defaultBranch);
      return name;
    };

    describe("projects and groups", () => {
      test("lists visible projects as domain objects, in id order", async () => {
        const all = await collect(t.api.projects.list());
        const mine = await t.api.projects.get(t.project);
        expect(all.find((p) => p.id === mine.id)).toEqual(mine);
        expect(all.map((p) => p.id)).toEqual(all.map((p) => p.id).sort((a, b) => a - b));
        expect(typeof mine.path).toBe("string");
        expect(mine.defaultBranch).toBeTruthy();
      });

      test("gets a project by id and by full path; an unknown one is not_found", async () => {
        const byRef = await t.api.projects.get(t.project);
        expect(await t.api.projects.get(byRef.id)).toEqual(byRef);
        expect(await t.api.projects.get(byRef.path)).toEqual(byRef);
        await failsWith("not_found", t.api.projects.get(2_000_000_000));
      });

      test("lists and gets groups", async () => {
        const groups = await collect(t.api.groups.list());
        expect(groups.map((g) => g.id)).toContain(t.group.id);
        expect((await t.api.groups.get(t.group.id)).path).toBe(t.group.path);
        await failsWith("not_found", t.api.groups.get(2_000_000_000));
      });
    });

    describe("repository", () => {
      test("creates a branch; creating it again is invalid", async () => {
        const name = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
        branches.push(name);
        const b = await t.api.repository.createBranch(t.project, name, defaultBranch);
        expect(b).toMatchObject({ name, default: false });
        expect(b.commitId).toMatch(/^[0-9a-f]{40}$/);
        await failsWith("invalid", t.api.repository.createBranch(t.project, name, defaultBranch));
        await failsWith(
          "invalid",
          t.api.repository.createBranch(t.project, `${name}-x`, "no-such-ref-orch"),
        );
      });

      test("gets a branch; one that is not there is not_found", async () => {
        const name = await newBranch();
        expect(await t.api.repository.getBranch(t.project, name)).toMatchObject({
          name,
          default: false,
        });
        expect(await t.api.repository.getBranch(t.project, defaultBranch)).toMatchObject({
          name: defaultBranch,
          default: true,
        });
        await failsWith("not_found", t.api.repository.getBranch(t.project, `${name}-none`));
      });

      test("commits several files at once and reads them back, tree and content", async () => {
        const branch = await newBranch();
        const root = `orch-contract/${branch}`;
        const commit = await t.api.repository.commitFiles(
          t.project,
          { branch, message: "contract: add files" },
          [
            { action: "create", path: `${root}/a.txt`, content: "héllo wörld\n" },
            { action: "create", path: `${root}/dir/b.json`, content: '{"k":1}' },
          ],
        );
        expect(commit.id).toMatch(/^[0-9a-f]{40}$/);

        const file = await t.api.repository.getFile(t.project, `${root}/a.txt`, branch);
        expect(file.content).toBe("héllo wörld\n");
        expect(file.path).toBe(`${root}/a.txt`);

        const all = await collect(t.api.repository.tree(t.project, { ref: branch, path: root }));
        expect(all.map((e) => `${e.type}:${e.path}`).sort()).toEqual([
          `blob:${root}/a.txt`,
          `blob:${root}/dir/b.json`,
          `tree:${root}/dir`,
        ]);
        const top = await collect(
          t.api.repository.tree(t.project, { ref: branch, path: root, recursive: false }),
        );
        expect(top.map((e) => e.path).sort()).toEqual([`${root}/a.txt`, `${root}/dir`]);
      });

      test("compare reports added, modified and deleted files", async () => {
        const branch = await newBranch();
        const dir = `orch-contract/${branch}`;
        await t.api.repository.commitFiles(t.project, { branch, message: "contract: add" }, [
          { action: "create", path: `${dir}/keep.txt`, content: "1" },
          { action: "create", path: `${dir}/gone.txt`, content: "1" },
        ]);
        const base = `${branch}-base`;
        branches.push(base);
        await t.api.repository.createBranch(t.project, base, branch);
        await t.api.repository.commitFiles(t.project, { branch, message: "contract: change" }, [
          { action: "update", path: `${dir}/keep.txt`, content: "2" },
          { action: "delete", path: `${dir}/gone.txt` },
          { action: "create", path: `${dir}/new.txt`, content: "3" },
        ]);
        const cmp = await t.api.repository.compare(t.project, base, branch);
        expect(cmp.timedOut).toBe(false);
        expect(cmp.files.map((f) => `${f.status}:${f.newPath}`).sort()).toEqual([
          `added:${dir}/new.txt`,
          `deleted:${dir}/gone.txt`,
          `modified:${dir}/keep.txt`,
        ]);

        const same = await t.api.repository.compare(t.project, branch, branch);
        expect(same.sameRef).toBe(true);
        expect(same.files).toEqual([]);

        expect((await t.api.repository.getFile(t.project, `${dir}/keep.txt`, branch)).content).toBe(
          "2",
        );
        await failsWith(
          "not_found",
          t.api.repository.getFile(t.project, `${dir}/gone.txt`, branch),
        );
      });

      test("a commit that contradicts the branch is invalid and applies nothing", async () => {
        const branch = await newBranch();
        const path = `orch-contract/${branch}/x.txt`;
        await t.api.repository.commitFiles(t.project, { branch, message: "contract: x" }, [
          { action: "create", path, content: "1" },
        ]);
        await failsWith(
          "invalid",
          t.api.repository.commitFiles(t.project, { branch, message: "contract: dup" }, [
            { action: "create", path: `${path}.other`, content: "1" },
            { action: "create", path, content: "again" },
          ]),
        );
        await failsWith("not_found", t.api.repository.getFile(t.project, `${path}.other`, branch));
        await failsWith(
          "invalid",
          t.api.repository.commitFiles(t.project, { branch, message: "contract: upd" }, [
            { action: "update", path: `${path}.missing`, content: "1" },
          ]),
        );
      });

      test("never commits to the default branch", async () => {
        const path = `orch-contract/default-${Bun.randomUUIDv7().slice(-8)}.txt`;
        await failsWith(
          "invalid",
          t.api.repository.commitFiles(t.project, { branch: defaultBranch, message: "no" }, [
            { action: "create", path, content: "1" },
          ]),
        );
        await failsWith("not_found", t.api.repository.getFile(t.project, path, defaultBranch));
      });

      test("startBranch only works for a branch that does not exist yet", async () => {
        const branch = await newBranch();
        await failsWith(
          "invalid",
          t.api.repository.commitFiles(
            t.project,
            { branch, startBranch: defaultBranch, message: "contract: exists" },
            [{ action: "create", path: `orch-contract/${branch}/e.txt`, content: "1" }],
          ),
        );
      });

      test("deletes a branch, once; the default branch is never deleted", async () => {
        const name = await newBranch();
        await t.api.repository.deleteBranch(t.project, name);
        await failsWith("not_found", t.api.repository.deleteBranch(t.project, name));
        await failsWith("invalid", t.api.repository.deleteBranch(t.project, defaultBranch));
        expect((await t.api.projects.get(t.project)).defaultBranch).toBe(defaultBranch);
        await t.api.repository.createBranch(t.project, name, defaultBranch); // the name is free again
      });

      test("commitFiles can start a new branch from another", async () => {
        const branch = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
        branches.push(branch);
        const path = `orch-contract/${branch}/s.txt`;
        await t.api.repository.commitFiles(
          t.project,
          { branch, startBranch: defaultBranch, message: "contract: start" },
          [{ action: "create", path, content: "s" }],
        );
        expect((await t.api.repository.getFile(t.project, path, branch)).content).toBe("s");
      });
    });

    describe("pipelines and CI lint", () => {
      // Manual jobs: the pipeline exists but no runner picks anything up.
      const CI = 'contract:\n  stage: test\n  when: manual\n  script:\n    - "true"\n';
      const ciBranch = async () => {
        const branch = await newBranch();
        const commit = await t.api.repository.commitFiles(
          t.project,
          { branch, message: "contract: ci" },
          [{ action: "create", path: ".gitlab-ci.yml", content: CI }],
        );
        return { branch, sha: commit.id };
      };

      test("triggers a pipeline with variables, reads it and its jobs, cancels and retries it", async () => {
        const { branch, sha } = await ciBranch();
        const p = await t.api.pipelines.trigger(t.project, branch, [
          { key: "CONTRACT_VAR", value: "contract-secret-value-1" },
        ]);
        expect(p).toMatchObject({ ref: branch, sha });
        expect(p.status).not.toBe("unknown");
        expect(JSON.stringify(p)).not.toContain("contract-secret-value-1");

        expect(await t.api.pipelines.get(t.project, p.id)).toMatchObject({ id: p.id, ref: branch });
        const jobs = await collect(t.api.pipelines.jobs(t.project, p.id));
        expect(jobs.map((j) => `${j.stage}:${j.name}`)).toEqual(["test:contract"]);

        expect((await t.api.pipelines.cancel(t.project, p.id)).id).toBe(p.id);
        expect((await t.api.pipelines.retry(t.project, p.id)).id).toBe(p.id);
        await t.api.pipelines.cancel(t.project, p.id);
      });

      test("an unknown ref is invalid, an unknown pipeline is not_found", async () => {
        await failsWith("invalid", t.api.pipelines.trigger(t.project, "orch-no-such-ref"));
        await failsWith("not_found", t.api.pipelines.get(t.project, 2_000_000_000));
      });

      test("lint reports valid config, and errors as a result rather than an exception", async () => {
        const ok = await t.api.ci.lint(t.project, CI);
        expect(ok).toMatchObject({ valid: true, errors: [] });
        expect(ok.mergedYaml).toContain("contract");

        const noScript = await t.api.ci.lint(t.project, "contract:\n  stage: test\n");
        expect(noScript.valid).toBe(false);
        expect(noScript.errors.join("\n")).toContain("contract");
        expect(noScript.mergedYaml).toBeNull();

        const broken = await t.api.ci.lint(t.project, "contract: [unclosed\n");
        expect(broken.valid).toBe(false);
        expect(broken.errors.length).toBeGreaterThan(0);
      });
    });

    describe("variables", () => {
      // Every variable made here is removed again, also when the test fails.
      const made: { owner: VariableOwner; ref: VariableRef }[] = [];
      afterEach(async () => {
        const left: unknown[] = [];
        for (const { owner, ref } of made.splice(0)) {
          await t.api.variables.delete(owner, ref).catch((e) => {
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
        input: Parameters<Gitlab["variables"]["create"]>[2],
      ) => {
        made.push({ owner, ref: { key, scope: input.scope } });
        return t.api.variables.create(owner, key, input);
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

          const listed = (await collect(t.api.variables.list(o))).find((v) => v.key === key);
          expect(listed?.value).toBe("contract-value-1");
          await failsWith("invalid", t.api.variables.create(o, key, { value: "contract-value-1" }));

          const updated = await t.api.variables.update(
            o,
            { key },
            { value: "contract-value-2", protected: true, masked: true, raw: true },
          );
          expect(updated).toMatchObject({ key, protected: true, scope: "*" });
          expect((await t.api.variables.get(o, { key })).value).toBe("contract-value-2");

          await t.api.variables.delete(o, { key });
          await failsWith("not_found", t.api.variables.get(o, { key }));
          await failsWith("not_found", t.api.variables.delete(o, { key }));
        });
      }

      test("scope-qualified update and delete touch only that scope, a missing scope is not_found", async () => {
        const o = projectOwner();
        const key = newKey();
        const scope = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
        await make(o, key, { value: "base-value-1" });
        await make(o, key, { value: "scoped-value-1", scope, type: "file" });

        const both = (await collect(t.api.variables.list(o))).filter((v) => v.key === key);
        expect(both.map((v) => v.scope).sort()).toEqual(["*", scope].sort());
        expect((await t.api.variables.get(o, { key, scope })).type).toBe("file");

        await t.api.variables.update(o, { key, scope }, { value: "scoped-value-2", type: "file" });
        expect((await t.api.variables.get(o, { key, scope })).value).toBe("scoped-value-2");
        expect((await t.api.variables.get(o, { key })).value).toBe("base-value-1");

        // A scope that does not exist must not fall through to the variable that does.
        const ghost = { key, scope: "orch-contract-ghost" };
        await failsWith("not_found", t.api.variables.update(o, ghost, { value: "clobbered-1" }));
        await failsWith("not_found", t.api.variables.delete(o, ghost));
        expect((await t.api.variables.get(o, { key })).value).toBe("base-value-1");
        expect((await t.api.variables.get(o, { key, scope })).value).toBe("scoped-value-2");

        const moved = `${scope}-moved`;
        made.push({ owner: o, ref: { key, scope: moved } });
        await t.api.variables.update(o, { key, scope }, { value: "scoped-value-2", scope: moved });
        await failsWith("not_found", t.api.variables.get(o, { key, scope }));
        expect((await t.api.variables.get(o, { key, scope: moved })).value).toBe("scoped-value-2");

        await t.api.variables.delete(o, { key, scope: moved });
        await failsWith("not_found", t.api.variables.get(o, { key, scope: moved }));
        expect((await t.api.variables.get(o, { key })).value).toBe("base-value-1");
        await t.api.variables.delete(o, { key });
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

    describe("the token", () => {
      test("reports its scopes and expiry", async () => {
        const info = await t.api.users.tokenInfo();
        expect(info.scopes.length).toBeGreaterThan(0);
        expect(info.expiresAt === null || /^\d{4}-\d{2}-\d{2}/.test(info.expiresAt)).toBe(true);
      });
    });

    describe("members", () => {
      test("the token's user is an active member of the project and the group", async () => {
        const me = await t.api.users.current();
        expect(me.active).toBe(true);
        // The project is one the token writes to: Developer or better.
        expect(
          await t.api.members.accessLevel({ project: t.project }, me.gitlabId),
        ).toBeGreaterThanOrEqual(30);
        expect(await t.api.members.accessLevel({ group: t.group.id }, me.gitlabId)).toBeGreaterThan(
          0,
        );
        expect(
          await t.api.members.accessLevel({ group: t.group.path }, me.gitlabId),
        ).toBeGreaterThan(0);
      });

      test("a user who is not a member, and a project or group that is not there, hold nothing", async () => {
        const nobody = 2_000_000_000;
        expect(await t.api.members.accessLevel({ project: t.project }, nobody)).toBe(0);
        expect(await t.api.members.accessLevel({ group: t.group.id }, nobody)).toBe(0);
        const me = await t.api.users.current();
        expect(
          await t.api.members.accessLevel({ project: "no-such-group/none" }, me.gitlabId),
        ).toBe(0);
        expect(await t.api.members.accessLevel({ group: "no-such-group-orch" }, me.gitlabId)).toBe(
          0,
        );
      });
    });

    describe("merge requests", () => {
      test("opens, reads, edits, closes and reopens a merge request; one open MR per branch", async () => {
        const branch = await newBranch();
        const commit = await t.api.repository.commitFiles(
          t.project,
          { branch, message: "contract: mr" },
          [{ action: "create", path: `orch-contract/${branch}/mr.txt`, content: "1" }],
        );
        const mr = await t.api.mergeRequests.create(t.project, {
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
          t.api.mergeRequests.create(t.project, {
            sourceBranch: branch,
            targetBranch: defaultBranch,
            title: "contract: again",
          }),
        );
        await failsWith(
          "invalid",
          t.api.mergeRequests.create(t.project, {
            sourceBranch: branch,
            targetBranch: branch,
            title: "contract: same",
          }),
        );

        expect(await t.api.mergeRequests.get(t.project, mr.iid)).toEqual(mr);
        const edited = await t.api.mergeRequests.update(t.project, mr.iid, {
          title: "contract: edited",
          description: "new text",
        });
        expect(edited).toMatchObject({
          iid: mr.iid,
          title: "contract: edited",
          description: "new text",
        });

        const closed = await t.api.mergeRequests.update(t.project, mr.iid, { state: "closed" });
        expect(closed.state).toBe("closed");
        const reopened = await t.api.mergeRequests.update(t.project, mr.iid, { state: "opened" });
        expect(reopened.state).toBe("opened");

        await t.api.mergeRequests.update(t.project, mr.iid, { state: "closed" });
        await failsWith("not_found", t.api.mergeRequests.get(t.project, 2_000_000_000));
      });

      test("lists the merge requests of a source branch by state", async () => {
        const branch = await newBranch();
        await t.api.repository.commitFiles(t.project, { branch, message: "contract: list" }, [
          { action: "create", path: `orch-contract/${branch}/l.txt`, content: "1" },
        ]);
        const where = { sourceBranch: branch, targetBranch: defaultBranch };
        expect(await collect(t.api.mergeRequests.list(t.project, where))).toEqual([]);
        const mr = await t.api.mergeRequests.create(t.project, {
          ...where,
          title: "contract: list",
        });
        const opened = await collect(
          t.api.mergeRequests.list(t.project, { ...where, state: "opened" }),
        );
        expect(opened.map((m) => m.iid)).toEqual([mr.iid]);
        await t.api.mergeRequests.update(t.project, mr.iid, { state: "closed" });
        expect(
          await collect(t.api.mergeRequests.list(t.project, { ...where, state: "opened" })),
        ).toEqual([]);
        expect(
          (await collect(t.api.mergeRequests.list(t.project, where))).map((m) => m.iid),
        ).toEqual([mr.iid]);
      });

      test("creates and edits a note", async () => {
        const branch = await newBranch();
        await t.api.repository.commitFiles(t.project, { branch, message: "contract: note" }, [
          { action: "create", path: `orch-contract/${branch}/n.txt`, content: "1" },
        ]);
        const mr = await t.api.mergeRequests.create(t.project, {
          sourceBranch: branch,
          targetBranch: defaultBranch,
          title: "contract: notes",
        });
        const note = await t.api.mergeRequests.createNote(t.project, mr.iid, "first");
        expect(note).toMatchObject({ body: "first", system: false });
        const edited = await t.api.mergeRequests.updateNote(t.project, mr.iid, note.id, "second");
        expect(edited).toMatchObject({ id: note.id, body: "second" });
        const read = await t.api.mergeRequests.getNote(t.project, mr.iid, note.id);
        expect(read).toMatchObject({ id: note.id, body: "second", system: false });
        expect(typeof read.authorId).toBe("number");
        await t.api.mergeRequests.update(t.project, mr.iid, { state: "closed" });
      });
    });
  });
}
