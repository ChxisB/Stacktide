import { z } from "zod";
import type { clientFor } from "./api";
import { call } from "./api";
import { CliError, type Context } from "./cli";
import { findProjectFile } from "./project";

type Api = ReturnType<typeof clientFor>;

/** What the user named: flags first, then `.orch.json`. Each is an id, or a name/slug the API knows. */
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

interface Named {
  id: string;
  name: string;
  slug?: string;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

async function every<T>(
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
async function idOf<T extends Named>(
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
 * The environment a command is about: `--org`, `--project` and `--env`, else the nearest `.orch.json`.
 * Names are looked up through the list endpoints, which a project-only member cannot read, so they
 * can always give ids.
 */
export async function resolveEnvironment(
  ctx: Context,
  apiUrl: string,
  client: Api,
  flags: TargetFlags,
): Promise<EnvironmentTarget> {
  const file = (await findProjectFile(ctx.cwd))?.config;
  const org = flags.org ?? file?.organization;
  const project = flags.project ?? file?.project;
  const env = flags.env ?? file?.environment;
  const missing = (what: string, flag: string) =>
    new CliError(`no ${what}: pass ${flag} or set it in .orch.json`, 2);
  if (!org) throw missing("organization", "--org");
  if (!project) throw missing("project", "--project");
  if (!env) throw missing("environment", "--env");

  const orgId = await idOf("organization", org, () =>
    every(apiUrl, (cursor) => client.organizations.get({ query: { limit: 100, cursor } })),
  );
  const projectId = await idOf("project", project, () =>
    every(apiUrl, (cursor) =>
      client.organizations({ orgId }).projects.get({ query: { limit: 100, cursor } }),
    ),
  );
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
