import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { componentFile, componentPath, validateCatalogLayout } from "./component";
import {
  CATALOG_DESCRIPTION,
  catalogReadme,
  latestVersions,
  RELEASE_CI,
  writeCatalogProject,
} from "./component-files";
import { loadTemplates, type Template } from "./loader";

const dirs: string[] = [];
const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-component-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const all = async (dir: string, at = ""): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const e of await readdir(join(dir, at), { withFileTypes: true })) {
    const path = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await all(dir, path));
    else out[path] = await readFile(join(dir, path), "utf8");
  }
  return out;
};
const bumped = (t: Template, version: string): Template => ({
  ...t,
  manifest: { ...t.manifest, version },
});

describe("the catalog project of the templates", () => {
  test("holds the newest version of each template as a component, a README and the release job, and passes the validator", async () => {
    const templates = await loadTemplates();
    const dir = await fresh();
    const paths = await writeCatalogProject(dir, templates);
    const files = await all(dir);
    expect(Object.keys(files).sort()).toEqual(paths);
    expect(validateCatalogLayout(files, CATALOG_DESCRIPTION)).toEqual([]);
    for (const t of latestVersions(templates))
      expect(files[componentPath(t.manifest)]).toBe(componentFile(t));
    expect(paths).toContain("README.md");
    expect(paths).toContain(".gitlab-ci.yml");
  });

  test("a second run changes nothing, byte for byte", async () => {
    const templates = await loadTemplates();
    const dir = await fresh();
    await writeCatalogProject(dir, templates);
    const first = await all(dir);
    await writeCatalogProject(dir, templates);
    expect(await all(dir)).toEqual(first);
  });

  test("an older version of a template is left out: the tag is the component's version", async () => {
    const [t] = await loadTemplates();
    if (!t) throw new Error("no templates shipped");
    const [older, newer] = [bumped(t, "0.9.0"), bumped(t, "1.10.0")];
    expect(
      latestVersions([newer, older, bumped(t, "1.2.0")]).map((x) => x.manifest.version),
    ).toEqual(["1.10.0"]);
    const dir = await fresh();
    await writeCatalogProject(dir, [older, newer]);
    expect(await readFile(join(dir, componentPath(t.manifest)), "utf8")).toContain(
      `${t.manifest.name}@1.10.0`,
    );
  });

  test("the README lists each component with its inputs and says how to publish", async () => {
    const latest = latestVersions(await loadTemplates());
    const readme = catalogReadme(latest);
    for (const t of latest)
      expect(readme).toContain(`| \`${t.manifest.name}\` | ${t.manifest.version} |`);
    expect(readme).toContain(CATALOG_DESCRIPTION);
    expect(readme).toContain("CI/CD Catalog project");
  });

  test("the release job runs on a semver tag alone and releases that tag", () => {
    const ci = parse(RELEASE_CI) as Record<
      string,
      { rules: { if: string }[]; release: { tag_name: string } }
    >;
    const job = ci["create-release"];
    expect(job?.release.tag_name).toBe("$CI_COMMIT_TAG");
    const cond = job?.rules[0]?.if ?? "";
    const re = new RegExp(/=~ \/(.*)\/$/.exec(cond)?.[1] ?? "(?!)");
    for (const ok of ["1.0.0", "12.34.56"]) expect(re.test(ok)).toBe(true);
    for (const no of ["v1.0.0", "1.0", "1.0.0-rc.1", "main", "~latest", "1.0.0\nx"])
      expect(re.test(no)).toBe(false);
  });

  test("a name that could leave the directory is refused before anything is written", async () => {
    const [t] = await loadTemplates();
    if (!t) throw new Error("no templates shipped");
    const evil: Template = { ...t, manifest: { ...t.manifest, name: "../../escape" } };
    const dir = await fresh();
    await expect(writeCatalogProject(dir, [evil])).rejects.toThrow("not a catalog project");
    expect(await readdir(dir)).toEqual([]);
  });

  test("the command writes the same files, and refuses to run without a directory", async () => {
    const script = join(import.meta.dir, "component-files.ts");
    const dir = await fresh();
    const ok = Bun.spawn(["bun", script, dir], { stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(ok.stdout).text()).trim().split("\n");
    expect(await ok.exited).toBe(0);
    expect(lines).toEqual(Object.keys(await all(dir)).sort());

    const bad = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    expect(await bad.exited).toBe(2);
    expect(await new Response(bad.stderr).text()).toContain("usage:");
  });
});
