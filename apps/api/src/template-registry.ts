import { type Db, listPipelineConsumers } from "@orch/db";
import { type Gitlab, GitlabError } from "@orch/gitlab";
import { byVersion, type ComponentInput, readComponent } from "@orch/pipelines";
import { gitlabProblem } from "./pipeline-apply";

/** How many of the newest releases are read: one tree request each. */
export const REGISTRY_RELEASES = 20;
/** A component file larger than this is reported, not parsed. */
export const COMPONENT_MAX_BYTES = 64 * 1024;
/** GitLab's own limit on the components of a project. */
const MAX_COMPONENTS = 100;

const RELEASE = /^\d+\.\d+\.\d+$/;
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const COMPONENT_FILE = /^templates\/([^/]+)(?:\.yml|\/template\.yml)$/;

export interface RegistryComponent {
  name: string;
  /** The releases (of the newest {@link REGISTRY_RELEASES}) that hold it, newest first. */
  versions: string[];
  /** Read from the newest of those; empty when `problem` is set. */
  inputs: ComponentInput[];
  /** Why the file could not be read, in words that carry none of its text. */
  problem: string | null;
}

/**
 * How a project that uses the catalog stands against its releases: `behind` when a newer release
 * exists than the one it follows, `unpinned` when it follows no release (no ref, a branch or a SHA),
 * `unpublished` when its release is not one the catalog lists.
 */
export type Standing = "up_to_date" | "behind" | "unpinned" | "unpublished";

export interface RegistryConsumer {
  projectId: string;
  projectName: string;
  template: string;
  mode: "include" | "component";
  ref: string | null;
  standing: Standing;
}

export interface Registry {
  project: string;
  /** Every release (a tag `1.2.3`), newest first. */
  releases: string[];
  latest: string | null;
  /** More releases than were read. */
  truncated: boolean;
  components: RegistryComponent[];
}

const notFound = <T>(read: Promise<T>, otherwise: T) =>
  read.catch((e) => {
    if (e instanceof GitlabError && e.kind === "not_found") return otherwise;
    throw e;
  });

async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A ref is a release (`1.2.3`) or a partial one (`1`, `1.2`) that follows the newest release it matches. */
export function standing(ref: string | null, releases: string[]): Standing {
  const latest = releases[0];
  if (!latest) return "unpublished";
  if (!ref || !/^\d+(\.\d+){0,2}$/.test(ref)) return "unpinned";
  if (!releases.some((r) => r === ref || r.startsWith(`${ref}.`))) return "unpublished";
  const have = ref.split(".");
  const newest = latest.split(".");
  return have.some((n, i) => n !== newest[i]) ? "behind" : "up_to_date";
}

/** The organization's projects that include this catalog project and where each stands (CMP-5); reads only the database. */
export async function consumersOf(
  db: Db,
  orgId: string,
  { project, releases }: Pick<Registry, "project" | "releases">,
): Promise<RegistryConsumer[]> {
  return (await listPipelineConsumers(db, orgId, project)).map(({ config, projectName }) => ({
    projectId: config.projectId,
    projectName,
    template: config.template,
    mode: config.mode === "component" ? "component" : "include",
    ref: config.includeRef,
    standing: standing(config.includeRef, releases),
  }));
}

/** The inputs of `templates/<name>.yml` (or `<name>/template.yml`) at `ref`, or why they cannot be read. */
async function readFile(api: Gitlab, project: string, name: string, ref: string) {
  for (const path of [`templates/${name}.yml`, `templates/${name}/template.yml`]) {
    const file = await notFound(api.repository.getFile(project, path, ref), null);
    if (!file) continue;
    if (file.size > COMPONENT_MAX_BYTES)
      return { problem: `the file is larger than ${COMPONENT_MAX_BYTES / 1024} KiB` };
    const read = readComponent(file.content);
    return "problem" in read ? { problem: `the file ${read.problem}` } : read;
  }
  return { problem: "the file is missing" };
}

/**
 * What a catalog project publishes (CMP-4): its releases, and per component the releases that hold
 * it and the inputs it declares at the newest of them. Reads only: the tags, the `templates/` tree
 * of each of the newest releases and the component files at their newest release. A component file
 * that cannot be read (not YAML, no `spec:`, too big, gone) is reported on its component, not
 * thrown, and its text is never copied into the answer. A project the token cannot see is a 422.
 */
export async function readRegistry(api: Gitlab, project: string): Promise<Registry> {
  try {
    const releases: string[] = [];
    // shortcut: every tag page is read, so a project with thousands of tags is slow; cap the pages when one shows up
    for await (const tag of api.repository.tags(project))
      if (RELEASE.test(tag.name)) releases.push(tag.name);
    releases.sort((a, b) => byVersion(b, a));
    const read = releases.slice(0, REGISTRY_RELEASES);

    const versions = new Map<string, string[]>();
    // at most REGISTRY_RELEASES requests at once; the results are read in release order
    const trees = await Promise.all(
      read.map((ref) =>
        notFound(collect(api.repository.tree(project, { ref, path: "templates" })), []),
      ),
    );
    read.forEach((ref, i) => {
      for (const entry of trees[i] ?? []) {
        const name = COMPONENT_FILE.exec(entry.path)?.[1];
        if (entry.type === "blob" && name && NAME.test(name))
          versions.set(name, [...new Set([...(versions.get(name) ?? []), ref])]);
      }
    });

    const components: RegistryComponent[] = [];
    // shortcut: one file read after another (up to MAX_COMPONENTS), and the size cap is checked after the read; bound both in packages/gitlab if a catalog needs it
    const named = [...versions].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_COMPONENTS);
    for (const [name, has] of named) {
      const file = await readFile(api, project, name, has[0] as string);
      components.push({
        name,
        versions: has,
        inputs: "inputs" in file ? file.inputs : [],
        problem: "problem" in file ? file.problem : null,
      });
    }
    return {
      project,
      releases,
      latest: releases[0] ?? null,
      truncated: releases.length > read.length,
      components,
    };
  } catch (e) {
    throw gitlabProblem(e);
  }
}
