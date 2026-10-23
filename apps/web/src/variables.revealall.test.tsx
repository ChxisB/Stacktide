import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import { VariablesPage } from "./variables";
import { openSecrets, rowOf, SECRET, scene as sceneOn, showSecrets } from "./variables.fixture";

// VWS-7: Reveal all reads the environment's values from the audited export route, shows them for a
// while, and holds them nowhere but the component.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);
const OTHER = "an0ther-s3cr3t-77d1";
const FILE = "-----BEGIN-----\nfile-body-5e8a\n-----END-----";

/** The page alone, with a short time before the values hide again. */
function mountPage(client: ReturnType<Backend["anonymous"]>, revealMs: number) {
  const queries = mount(client).queries;
  document.body.innerHTML = "";
  return render(
    <Providers client={client} queries={queries}>
      <AuthGate>
        <OrgProvider>
          <RequireOrg>{(org) => <VariablesPage orgId={org.id} revealMs={revealMs} />}</RequireOrg>
        </OrgProvider>
      </AuthGate>
    </Providers>,
  );
}

/** A client that notes the path of every request it makes. */
function watched(cookie: string) {
  const paths: string[] = [];
  const client = clientVia(backend.api, cookie, (request, send) => {
    paths.push(`${request.method} ${pathOf(request)}`);
    return send();
  });
  return { client, paths };
}

async function withSecrets() {
  const s = await scene();
  await s.put.project("API_KEY", SECRET, true);
  await s.put.env("dev", "OTHER_KEY", OTHER, true);
  await s.put.project("REGION", "eu");
  await s.scope.variables.post({ key: "CERT", kind: "file", value: FILE });
  await s.put.env("staging", "STAGING_ONLY", "staging-secret-3b9", true);
  return s;
}

const reveal = () => screen.getByRole("button", { name: "Reveal all" });
const hasNone = () => {
  const text = document.body.textContent ?? "";
  for (const value of [SECRET, OTHER, "file-body-5e8a", "staging-secret-3b9"])
    expect(text).not.toContain(value);
};

describe("Reveal all", () => {
  test("no value is on the page until it is pressed, then every secret and file of the environment is", async () => {
    const s = await withSecrets();
    mount(s.client);
    const table = await openSecrets();
    hasNone();
    const user = userEvent.setup();
    await user.click(reveal());
    await within(table).findByText(SECRET);
    expect(within(table).getByText(OTHER).className).toBe("revealed");
    expect(within(table).getByText(/file-body-5e8a/).textContent).toBe(FILE);
    // a plain value reads as it did, and another environment's secret is not here
    expect(within(table).getByText("eu")).toBeTruthy();
    expect(document.body.textContent).not.toContain("staging-secret-3b9");
    expect(
      within(rowOf(table, "API_KEY")[0] as HTMLElement).queryByText("Hidden value"),
    ).toBeNull();
  });

  test("the only request it makes is the environment's values route", async () => {
    const s = await withSecrets();
    const { client, paths } = watched(s.cookie);
    mount(client);
    const table = await openSecrets();
    const before = paths.length;
    await userEvent.setup().click(reveal());
    await within(table).findByText(SECRET);
    const made = paths.slice(before).filter((p) => !p.startsWith("GET /api/auth"));
    expect(made).toEqual([
      `GET /organizations/${s.org.id}/projects/${s.project.id}/environments/${s.envs.dev}/resolved-variables/values`,
    ]);
    // the audited route wrote its rows: one per secret or file, and one for the export
    expect(await s.audit("variable.reveal")).toHaveLength(3);
    expect(await s.audit("variable.export")).toHaveLength(1);
  });

  test("the values hide themselves after the time", async () => {
    const s = await withSecrets();
    mountPage(s.client, 300);
    const table = await openSecrets();
    await userEvent.setup().click(reveal());
    await within(table).findByText(SECRET);
    await waitFor(hasNone, { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    expect(within(table).getAllByText("Hidden value").length).toBe(3);
  });

  test("Hide all hides them at once", async () => {
    const s = await withSecrets();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(reveal());
    await within(table).findByText(SECRET);
    await user.click(screen.getByRole("button", { name: "Hide all" }));
    hasNone();
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
  });

  test("choosing another environment hides them, and the other environment's are not read until asked", async () => {
    const s = await withSecrets();
    const { client, paths } = watched(s.cookie);
    mount(client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(reveal());
    await within(table).findByText(SECRET);
    await showSecrets("staging");
    await screen.findByRole("table", { name: "Variables in staging" });
    hasNone();
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    expect(paths.filter((p) => p.endsWith("/values"))).toHaveLength(1);
  });

  test("an answer that arrives after another environment was chosen is dropped", async () => {
    const s = await withSecrets();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      const answer = await send();
      if (pathOf(request).endsWith("/values")) await gate;
      return answer;
    });
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(reveal());
    await showSecrets("staging");
    await screen.findByRole("table", { name: "Variables in staging" });
    release();
    // the request is answered; give the page its turn, then look
    await new Promise((resolve) => setTimeout(resolve, 300));
    hasNone();
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
  });

  test("leaving the page hides them: nothing of them is in the page or its cache after unmount", async () => {
    const s = await withSecrets();
    const shown = mount(s.client);
    const table = await openSecrets();
    await userEvent.setup().click(reveal());
    await within(table).findByText(SECRET);
    shown.unmount();
    hasNone();
    expect(
      JSON.stringify(
        shown.queries
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
  });

  test("the answer is not kept in the query cache while it is shown", async () => {
    const s = await withSecrets();
    const shown = mount(s.client);
    const table = await openSecrets();
    await userEvent.setup().click(reveal());
    await within(table).findByText(SECRET);
    const cached = JSON.stringify(
      shown.queries
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    );
    expect(cached).not.toContain(SECRET);
    expect(cached).not.toContain(OTHER);
    expect(cached).not.toContain("file-body-5e8a");
  });

  test("a key that does not resolve is still not shown a value", async () => {
    const s = await withSecrets();
    await s.put.project("BROKEN", `\${NOWHERE}`);
    mount(s.client);
    const table = await openSecrets();
    await userEvent.setup().click(reveal());
    await within(table).findByText(SECRET);
    expect(
      within(rowOf(table, "BROKEN")[0] as HTMLElement).getByText(/Does not resolve/),
    ).toBeTruthy();
  });

  test("the details of an open secret show its value while the values are shown", async () => {
    const s = await withSecrets();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "API_KEY" }));
    const region = await screen.findByRole("region", { name: "API_KEY" });
    await within(region).findByText("Version");
    expect(within(region).queryByText(SECRET)).toBeNull();
    await user.click(reveal());
    await within(region).findByText(SECRET);
    await user.click(screen.getByRole("button", { name: "Hide all" }));
    expect(within(region).queryByText(SECRET)).toBeNull();
  });
});

describe("after a write", () => {
  test("a secret that was just changed is not left on the page as the current value", async () => {
    const s = await withSecrets();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "API_KEY" }));
    const region = await screen.findByRole("region", { name: "API_KEY" });
    await within(region).findByText("Version");
    await user.click(reveal());
    await within(region).findByText(SECRET);
    await user.click(within(region).getByRole("button", { name: "Edit API_KEY in dev" }));
    const box = screen.getByLabelText("New value");
    await user.clear(box);
    await user.type(box, "n3w-s3cr3t-0f1e");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // the values hide: the button to show them again is back, and none of the old ones is on the page
    await screen.findByRole("button", { name: "Reveal all" });
    hasNone();
    expect(document.body.textContent).not.toContain("n3w-s3cr3t-0f1e");
  });
});

describe("without the right to reveal", () => {
  test("the button says so, shows no value, and can be tried again", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(reveal());
    expect((await screen.findByRole("alert")).textContent).toBe("You cannot reveal values here");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(within(table).getByText("Hidden value")).toBeTruthy();
    expect((reveal() as HTMLButtonElement).disabled).toBe(false);
    expect(await s.audit("variable.reveal")).toHaveLength(0);
    expect(await s.audit("variable.export")).toHaveLength(0);
  });
});
