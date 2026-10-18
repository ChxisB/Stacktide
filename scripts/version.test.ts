import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, bump, bumpOf, notes, parse, plan } from "./version";

const changes = (...messages: string[]) =>
  messages.map((m, i) => parse(`${i}`.padStart(7, "a"), m)).filter((c) => c !== undefined);

describe("parse", () => {
  test("reads type, scope and subject; breaking by `!` or a footer", () => {
    expect(parse("abc1234", "feat(api): add x")).toMatchObject({
      type: "feat",
      scope: "api",
      subject: "add x",
      breaking: false,
    });
    expect(parse("abc1234", "fix!: drop y")?.breaking).toBe(true);
    expect(parse("abc1234", "feat: a\n\nBREAKING CHANGE: b")?.breaking).toBe(true);
    // a body that merely mentions it is not a footer
    expect(parse("abc1234", "feat: a\n\nno BREAKING CHANGE: here")?.breaking).toBe(false);
  });

  test("ignores a message that is not a conventional commit", () => {
    expect(parse("abc1234", "Merge pull request #1 from x/y")).toBeUndefined();
    expect(parse("abc1234", "wip")).toBeUndefined();
  });
});

describe("bumpOf", () => {
  test("the largest change wins", () => {
    expect(bumpOf(changes("fix: a", "feat: b"), "1.2.3")).toBe("minor");
    expect(bumpOf(changes("fix: a", "feat!: b"), "1.2.3")).toBe("major");
    expect(bumpOf(changes("perf: a"), "1.2.3")).toBe("patch");
  });

  test("while below 1.0.0 a breaking change is a minor bump: 1.0.0 is chosen by hand", () => {
    expect(bumpOf(changes("feat!: a"), "0.4.2")).toBe("minor");
  });

  test("docs, chore, test, ci and refactor alone release nothing", () => {
    expect(
      bumpOf(changes("docs: a", "chore: b", "test: c", "ci: d", "refactor: e", "wip"), "1.0.0"),
    ).toBeUndefined();
  });
});

test("bump", () => {
  expect(bump("1.2.3", "patch")).toBe("1.2.4");
  expect(bump("1.2.3", "minor")).toBe("1.3.0");
  expect(bump("1.2.3", "major")).toBe("2.0.0");
  expect(() => bump("1.2", "patch")).toThrow("not a version");
  expect(() => bump("1.2.3-rc.1", "patch")).toThrow("not a version");
});

test("notes group by kind, put breaking changes first and leave out the rest", () => {
  const text = notes(
    "0.2.0",
    "2026-10-18",
    changes("fix(db): f", "feat(api): g", "docs: d", "feat!: h"),
  );
  expect(text).toBe(
    [
      "## v0.2.0 (2026-10-18)",
      "",
      "### Breaking changes",
      "- h (aaaaaa3)",
      "",
      "### Features",
      "- **api:** g (aaaaaa1)",
      "- h (aaaaaa3)",
      "",
      "### Fixes",
      "- **db:** f (aaaaaa0)",
      "",
    ].join("\n"),
  );
});

describe("plan and apply on a real repository", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-version-test-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  let n = 0;
  async function repo() {
    const dir = join(root, `r${++n}`);
    await mkdir(join(dir, "apps", "cli"), { recursive: true });
    const git = async (...args: string[]) => {
      const run = await Bun.$`git -c user.name=t -c user.email=t@example.com ${args}`
        .cwd(dir)
        .quiet();
      return run.text();
    };
    await git("init", "--quiet", "-b", "main");
    return {
      dir,
      git,
      commit: (message: string) => git("commit", "--quiet", "--allow-empty", "-m", message),
    };
  }

  test("with no tag the first release counts every commit, from 0.0.0", async () => {
    const r = await repo();
    await r.commit("docs: start");
    await r.commit("feat: first");
    expect(await plan(r.dir, "2026-10-18")).toMatchObject({ version: "0.1.0", tag: "v0.1.0" });
  });

  test("after a tag only later commits count; nothing releasable is no release", async () => {
    const r = await repo();
    await r.commit("feat: first");
    await r.git("tag", "v0.1.0");
    await r.commit("chore: tidy");
    expect(await plan(r.dir, "2026-10-18")).toBeUndefined();
    await r.commit("fix: bug");
    const next = await plan(r.dir, "2026-10-18");
    expect(next?.version).toBe("0.1.1");
    expect(next?.notes).toContain("- bug (");
    expect(next?.notes).not.toContain("first");
  });

  test("a tag that is not a release version is refused, not skipped", async () => {
    const r = await repo();
    await r.commit("feat: first");
    await r.git("tag", "v1.0.0-rc.1");
    await r.commit("fix: bug");
    await expect(plan(r.dir, "2026-10-18")).rejects.toThrow("not a version");
  });

  test("apply sets the version in package.json and bun.lock and prepends the changelog", async () => {
    const r = await repo();
    await writeFile(
      join(r.dir, "apps/cli/package.json"),
      '{\n  "name": "@orch/cli",\n  "version": "0.1.0",\n  "type": "module"\n}\n',
    );
    await writeFile(
      join(r.dir, "bun.lock"),
      '{\n    "apps/web": {\n      "name": "@orch/web",\n      "version": "9.9.9",\n    },\n    "apps/cli": {\n      "name": "@orch/cli",\n      "version": "0.1.0",\n    },\n}\n',
    );
    await writeFile(join(r.dir, "CHANGELOG.md"), "# Changelog\n\n## v0.1.0 (2026-01-01)\n\nold\n");
    await apply(r.dir, "0.2.0", "## v0.2.0 (2026-10-18)\n\nnew\n");
    expect(await readFile(join(r.dir, "apps/cli/package.json"), "utf8")).toContain(
      '"version": "0.2.0"',
    );
    const lock = await readFile(join(r.dir, "bun.lock"), "utf8");
    expect(lock).toContain('"@orch/cli",\n      "version": "0.2.0"');
    expect(lock).toContain('"version": "9.9.9"');
    expect(await readFile(join(r.dir, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n## v0.2.0 (2026-10-18)\n\nnew\n\n## v0.1.0 (2026-01-01)\n\nold\n",
    );
  });

  test("apply starts a changelog when there is none, and refuses a lock it cannot update", async () => {
    const r = await repo();
    await writeFile(join(r.dir, "apps/cli/package.json"), '{ "version": "0.1.0" }\n');
    await writeFile(join(r.dir, "bun.lock"), "{}\n");
    await expect(apply(r.dir, "0.2.0", "## v0.2.0\n")).rejects.toThrow("bun.lock");
    await writeFile(join(r.dir, "bun.lock"), '"name": "@orch/cli",\n      "version": "0.1.0",\n');
    await apply(r.dir, "0.2.0", "## v0.2.0\n");
    expect(await readFile(join(r.dir, "CHANGELOG.md"), "utf8")).toBe("# Changelog\n\n## v0.2.0\n");
  });
});
