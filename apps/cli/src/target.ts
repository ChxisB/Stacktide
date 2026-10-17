import { z } from "zod";
import type { clientFor } from "./api";
import { call } from "./api";
import { CliError, type Context } from "./cli";
import { findProjectFile } from "./project";

type Api = ReturnType<typeof clientFor>;

/** What the user named: flags first, then `ORCH_ORG`/`ORCH_PROJECT`/`ORCH_ENV`, then `.orch.json`. Each is an id, or a name/slug the API knows. */
export interface TargetFlags {
  org?: string | undefined;
  project?: string | undefined;
  env?: string | undefined;
}

export interface EnvironmentTarget {
  orgId: string;
  projectId: string;
  envId: string;
  /** How the user named it, for messages: `acme/web/staging`. */
  label: string;
}

const MAX_PAGES = 20;
const SHOWN = 10;

export interface Named {
  id: string;
  name: string;
  slug?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export async function every<T>(
  apiUrl: string,
  page: (
    cursor: string | undefined,
  ) => Promise<{ data: Page<T> | null; error: unknown; status: number }>,
): Promise<T[]> {
  const found: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { items, nextCursor } = await call(apiUrl, () => page(cursor));
    found.push(...items);
    if (!nextCursor) return found;
    cursor = nextCursor;
  }
  throw new CliError(`more than ${MAX_PAGES * 100} to look through: pass the id instead`, 2);
}

/**
 * The id for `ref`: itself when it is an id (the API answers 404 if it is wrong), else the one item
 * whose name or slug it is. Zero or several matches are errors that list what is known, never a guess.
 */
export async function idOf<T extends Named>(
  what: string,
  ref: string,
  list: () => Promise<T[]>,
): Promise<string> {
  if (z.uuid().safeParse(ref).success) return ref;
  const items = await list();
  const hits = items.filter((i) => i.name === ref || i.slug === ref);
  const [only] = hits;
  if (only && hits.length === 1) return only.id;
  if (hits.length > 1) {
    throw new CliError(`${hits.length} ${what}s are called '${ref}': use the id`, 2);
  }
  const names = items.map((i) => i.slug ?? i.name);
  throw new CliError(
    `no ${what} '${ref}'${
      names.length === 0
        ? ""
        : `; known: ${names.slice(0, SHOWN).join(", ")}${names.length > SHOWN ? ", ..." : ""}`
    }`,
    2,
  );
}

/**
 * `idOf` for something that may be left out: `ref` when given, else the only one there is. With none
 * or several, an error that says what to pass, never a guess.
 */
export async function onlyOrNamed<T extends Named>(
  what: string,
  flag: string,
  ref: string | undefined,
  list: () => Promise<T[]>,
): Promise<string> {
  if (ref) return idOf(what, ref, list);
  const items = await list();
  const [only] = items;
  if (only && items.length === 1) return only.id;
  if (items.length === 0) throw new CliError(`no ${what} here`, 2);
  const names = items.map((i) => i.slug ?? i.name);
  throw new CliError(
    `${items.length} ${what}s: pass ${flag}; known: ${names.slice(0, SHOWN).join(", ")}${names.length > SHOWN ? ", ..." : ""}`,
    2,
  );
}

/**
 * What the user named, one field at a time: `--org`, `--project` and `--env`, else `ORCH_ORG`,
 * `ORCH_PROJECT` and `ORCH_ENV` (what `orch ci login` prints), else the nearest `.orch.json`.
 */
async function named(ctx: Context, flags: TargetFlags) {
  const file = (await findProjectFile(ctx.cwd))?.config;
  return {
    org: flags.org ?? (ctx.env.ORCH_ORG || undefined) ?? file?.organization,
    project: flags.project ?? (ctx.env.ORCH_PROJECT || undefined) ?? file?.project,
    env: flags.env ?? (ctx.env.ORCH_ENV || undefined) ?? file?.environment,
  };
}
const missing = (what: string, flag: string, variable: string) =>
  new CliError(`no ${what}: pass ${flag}, set ${variable} or put it in .orch.json`, 2);

async function projectOf(apiUrl: string, client: Api, org: string, project: string) {
  const orgId = await idOf("organization", org, () =>
    every(apiUrl, (cursor) => client.organizations.get({ query: { limit: 100, cursor } })),
  );
  const projectId = await idOf("project", project, () =>
    every(apiUrl, (cursor) =>
      client.organizations({ orgId }).projects.get({ query: { limit: 100, cursor } }),
    ),
  );
  return { orgId, projectId };
}

export interface ProjectTarget {
  orgId: string;
  projectId: string;
  /** How the user named it, for messages: `acme/web`. */
  label: string;
}

/**
 * The project a command is about (see `named`). Names are looked up through the list endpoints, which
 * a project-only member (or a CI token) cannot read, so they can always give ids.
 */
export async function resolveProject(
  ctx: Context,
  apiUrl: string,
  client: Api,
  flags: Pick<TargetFlags, "org" | "project">,
): Promise<ProjectTarget> {
  const { org, project } = await named(ctx, flags);
  if (!org) throw missing("organization", "--org", "ORCH_ORG");
  if (!project) throw missing("project", "--project", "ORCH_PROJECT");
  return { ...(await projectOf(apiUrl, client, org, project)), label: `${org}/${project}` };
}

/** The environment a command is about: the project (see `resolveProject`) and `--env`. */
export async function resolveEnvironment(
  ctx: Context,
  apiUrl: string,
  client: Api,
  flags: TargetFlags,
): Promise<EnvironmentTarget> {
  const { org, project, env } = await named(ctx, flags);
  if (!org) throw missing("organization", "--org", "ORCH_ORG");
  if (!project) throw missing("project", "--project", "ORCH_PROJECT");
  if (!env) throw missing("environment", "--env", "ORCH_ENV");

  const { orgId, projectId } = await projectOf(apiUrl, client, org, project);
  const envId = await idOf("environment", env, () =>
    every(apiUrl, (cursor) =>
      client
        .organizations({ orgId })
        .projects({ projectId })
        .environments.get({ query: { limit: 100, cursor } }),
    ),
  );
  return { orgId, projectId, envId, label: `${org}/${project}/${env}` };
}
