import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Gitlab, GitlabError, type GitlabErrorKind, type ProjectRef } from "./index";

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
    afterAll(() => stop());

    const newBranch = async () => {
      const name = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
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
        const b = await t.api.repository.createBranch(t.project, name, defaultBranch);
        expect(b).toMatchObject({ name, default: false });
        expect(b.commitId).toMatch(/^[0-9a-f]{40}$/);
        await failsWith("invalid", t.api.repository.createBranch(t.project, name, defaultBranch));
        await failsWith(
          "invalid",
          t.api.repository.createBranch(t.project, `${name}-x`, "no-such-ref-orch"),
        );
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

      test("commitFiles can start a new branch from another", async () => {
        const branch = `orch-contract-${Bun.randomUUIDv7().slice(-12)}`;
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
        await t.api.mergeRequests.update(t.project, mr.iid, { state: "closed" });
      });
    });
  });
}
