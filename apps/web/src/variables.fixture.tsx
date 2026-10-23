import { auditEvents, createProject } from "@orch/db";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    admin,
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

const GRID = "Variables by environment";

/** The matrix's collapsed cell of a variable in an environment: its mark and the words that go with it. */
export function markOf(key: string, env: string) {
  const grid = within(screen.getByRole("table", { name: GRID }));
  const column = grid.getAllByRole("columnheader").findIndex((h) => h.textContent === env);
  if (column < 1) throw new Error(`no column ${env}`);
  const row = grid.getByRole("rowheader", { name: new RegExp(`^${key}$`) }).closest("tr");
  if (!row) throw new Error(`no row ${key}`);
  return within(row).getAllByRole("cell")[column - 1] as HTMLElement;
}

/** A key's open row in the matrix: the list of its environments (opens the row when it is closed). */
export function rowList(key: string) {
  const grid = within(screen.getByRole("table", { name: GRID }));
  const toggle = grid.getByRole("button", { name: key });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return screen.getByRole("list", { name: `${key} by environment` });
}

/** A variable's line for one environment, in its open row: what the old matrix cell held, bar its buttons. */
export function cellOf(key: string, env: string) {
  const line = within(rowList(key))
    .getAllByRole("listitem")
    .find((li) => li.firstElementChild?.textContent === env);
  if (!line) throw new Error(`no line for ${key} in ${env}`);
  return line;
}

/** Opens the details drawer of a variable in an environment, from its line in the matrix. */
export async function detailsOf(
  user: ReturnType<typeof userEvent.setup>,
  key: string,
  env: string,
) {
  await user.click(within(cellOf(key, env)).getByRole("button", { name: `${key} in ${env}` }));
  return screen.findByRole("dialog", { name: `${key} in ${env}` });
}

/** Clicks Edit value on a variable's line in an environment (opens its row when it is closed). */
export const editOf = (user: ReturnType<typeof userEvent.setup>, key: string, env: string) =>
  user.click(
    within(cellOf(key, env)).getByRole("button", { name: `Edit value of ${key} in ${env}` }),
  );

/** Chooses an item of a line's menu, for example "Delete" or "Add override" (opens its row when it is closed). */
export async function fromMenu(
  user: ReturnType<typeof userEvent.setup>,
  key: string,
  env: string,
  item: string,
) {
  await user.click(
    within(cellOf(key, env)).getByRole("button", { name: `More actions for ${key} in ${env}` }),
  );
  await user.click(screen.getByRole("menuitem", { name: item }));
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

/** The environment menu's button, once the page has its environments. */
export const envButton = () => screen.findByRole("button", { name: /^Environment/ });
/** Opens the environment menu (leaves it be when it is open) and returns it. */
export async function openEnvs(user: ReturnType<typeof userEvent.setup>) {
  const button = await envButton();
  if (button.getAttribute("aria-expanded") !== "true") await user.click(button);
  return screen.getByRole("group", { name: "Environment" });
}
/** Makes these environments, and only these, the ones shown: ticks them first, so there is always one ticked. */
export async function showEnvs(...names: string[]) {
  const user = userEvent.setup();
  // what the button shows is what is ticked, so a page already there is left alone
  if ((await envButton()).textContent === names.join(", ")) return;
  const menu = await openEnvs(user);
  const box = (n: string) => within(menu).getByRole("checkbox", { name: n }) as HTMLInputElement;
  for (const n of names) if (!box(n).checked) await user.click(box(n));
  for (const b of within(menu).getAllByRole("checkbox") as HTMLInputElement[]) {
    const name = b.closest("label")?.textContent ?? "";
    if (name !== "All environments" && b.checked && !names.includes(name)) await user.click(b);
  }
  await user.keyboard("{Escape}");
}
/** Chooses All environments (the matrix) in the environment menu, once the page has its environments. */
export async function showCompare() {
  const user = userEvent.setup();
  if ((await envButton()).textContent === "All environments") return;
  const menu = await openEnvs(user);
  await user.click(within(menu).getByRole("checkbox", { name: "All environments" }));
  await user.keyboard("{Escape}");
}
/** Chooses one environment (the list; the page opens on the first), which waits until the page has its environments. */
export const showSecrets = (env = "dev") => showEnvs(env);
/** Adds an environment through the dialog, from the menu or, when the project has none, from the page. */
export async function addEnvironment(user: ReturnType<typeof userEvent.setup>, name: string) {
  // the page has either the menu or, with no environment, a button of its own: wait for whichever it is
  const [first] = await screen.findAllByRole("button", { name: /^Environment|^Add environment$/ });
  if (first?.getAttribute("aria-label")?.startsWith("Environment")) {
    await user.click(within(await openEnvs(user)).getByRole("button", { name: "Add environment" }));
  } else {
    await user.click(first as HTMLElement);
  }
  const form = await screen.findByRole("form", { name: "Add an environment" });
  await user.type(within(form).getByLabelText("New environment"), name);
  await user.click(within(form).getByRole("button", { name: "Add environment" }));
}
/** Chooses an item of the list's Add New menu (the list has no other Add a variable or Import variables button). */
export async function addNew(
  user: ReturnType<typeof userEvent.setup>,
  item: "Add a variable" | "Import variables",
) {
  await user.click(await screen.findByRole("button", { name: "Add New" }));
  await user.click(screen.getByRole("menuitem", { name: item }));
}
/** Opens the Secrets view and returns the table of one environment. */
export async function openSecrets(env = "dev") {
  await showSecrets(env);
  return screen.findByRole("table", { name: `Variables in ${env}` });
}
/** The value, source and action cells of a variable's row (the select box's cell, which an admin's list has first, is not one). */
export const rowOf = (table: HTMLElement, key: string) => {
  const row = within(table).getByRole("rowheader", { name: key }).closest("tr");
  if (!row) throw new Error(`no row ${key}`);
  return within(row)
    .getAllByRole("cell")
    .filter((c) => !c.classList.contains("select"));
};

/** A clipboard that keeps what it was given (or one that refuses, or none at all), put back afterwards. */
export async function withClipboard(
  how: "keeps" | "refuses" | "none",
  test: (written: string[], user: ReturnType<typeof userEvent.setup>) => Promise<void>,
) {
  // set up first: user-event puts a clipboard of its own on the window when it is set up
  const user = userEvent.setup();
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const written: string[] = [];
  const writeText = async (text: string) => {
    if (how === "refuses") throw new Error("no permission");
    written.push(text);
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: how === "none" ? undefined : { writeText },
  });
  try {
    await test(written, user);
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
}
