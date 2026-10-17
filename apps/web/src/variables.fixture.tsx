import { auditEvents, createProject } from "@orch/db";
import { screen, within } from "@testing-library/react";
import { and, eq } from "drizzle-orm";
import { type Backend, clientVia, pathOf } from "./testing";

// What the variables screens' tests share: a scene (organization, project, environments, people),
// helpers to read the matrix, and a client that can hold a refresh. Not a test file.

export const SECRET = "s3cr3t-value-9f2c41";

/** A reference to another variable, as a value holds it. */
export const ref = (name: string) => `\${${name}}`;

/** What a call must have answered: a test that sets up through the API fails loudly when it did not. */
export function must<T>(res: { data: T | null; error: unknown }): T {
  if (res.data === null) throw new Error(`setup failed: ${JSON.stringify(res.error)}`);
  return res.data;
}

/**
 * An organization with a project, two environments (dev, staging), an admin and, when asked for,
 * a project reporter (who may read variables but not reveal a secret).
 */
export async function scene(
  backend: Backend,
  options: { reporter?: boolean; environments?: string[] } = {},
) {
  const org = await backend.organization();
  const project = await createProject(backend.t.db, { organizationId: org.id, name: "acme/web" });
  const admin = await backend.signIn(`admin of ${org.slug}`, {
    orgRoles: { [org.id]: "admin" },
    projectRoles: {},
  });
  const reporter = options.reporter
    ? await backend.signIn(`reporter of ${org.slug}`, {
        orgRoles: { [org.id]: "member" },
        projectRoles: { [project.id]: "reporter" },
      })
    : undefined;
  const orgScope = admin.client.organizations({ orgId: org.id });
  const scope = orgScope.projects({ projectId: project.id });
  const envs: Record<string, string> = {};
  for (const name of options.environments ?? ["dev", "staging"]) {
    const slug = name.toLowerCase();
    envs[name] = must(await scope.environments.post({ name, slug })).id;
  }
  const kind = (secret: boolean) => (secret ? "secret" : "plain") as "secret" | "plain";
  return {
    org,
    project,
    client: (reporter ?? admin).client,
    cookie: (reporter ?? admin).cookie,
    envs,
    scope,
    /** Variables made through the API, at the organization, the project or one environment. */
    put: {
      org: async (key: string, value: string, secret = false) =>
        must(await orgScope.variables.post({ key, kind: kind(secret), value })),
      project: async (key: string, value: string, secret = false) =>
        must(await scope.variables.post({ key, kind: kind(secret), value })),
      env: async (name: string, key: string, value: string, secret = false) =>
        must(
          await scope
            .environments({ envId: envs[name] ?? "" })
            .variables.post({ key, kind: kind(secret), value }),
        ),
    },
    audit: (action: string) =>
      backend.t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, org.id))),
  };
}

/** The table cell of a variable in an environment (of the grid: other tables may be on screen). */
export function cellOf(key: string, env: string) {
  const grid = within(screen.getByRole("table", { name: "Variables by environment" }));
  const column = grid.getAllByRole("columnheader").findIndex((h) => h.textContent === env);
  if (column < 1) throw new Error(`no column ${env}`);
  const row = grid.getByRole("rowheader", { name: key }).closest("tr");
  if (!row) throw new Error(`no row ${key}`);
  return within(row).getAllByRole("cell")[column - 1] as HTMLElement;
}

export const tagsOf = (cell: HTMLElement) =>
  Array.from(cell.querySelectorAll(".tag")).map((t) => t.textContent);

/** A client that can hold every read of a resolved set, to look at the screen between a write and its refresh. */
export function holding(backend: Backend, cookie: string) {
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const client = clientVia(backend.api, cookie, async (request, send) => {
    if (gate && pathOf(request).endsWith("/resolved-variables")) await gate;
    return send();
  });
  return {
    client,
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open?.(),
  };
}
