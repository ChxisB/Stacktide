import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseStateResources } from "@orch/core";
import { createProject, putState } from "@orch/db";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { StatePage } from "./state";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import { scene as sceneOn } from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/state";
});

type Scene = Awaited<ReturnType<typeof sceneOn>>;

/** What a job's state holds that must never be on screen: an output and an attribute value. */
const CANARY = "hunter2-CANARY-7f3a";
const aws = 'provider["registry.terraform.io/hashicorp/aws"]';
const res = (type: string, name: string, over: Record<string, unknown> = {}) => ({
  mode: "managed",
  type,
  name,
  provider: aws,
  instances: [{ schema_version: 0, attributes: { id: "x", password: CANARY } }],
  ...over,
});

/** Gives the stack a version for each serial, written the way a job would; returns each version's size. */
async function seed(s: Scene, stackName: string, serials: number[], resources: unknown[] = []) {
  const sizes: Record<number, number> = {};
  for (const serial of serials) {
    const content = JSON.stringify({
      version: 4,
      serial,
      lineage: "L-web",
      outputs: { password: { value: CANARY } },
      resources,
    });
    const parsed = parseStateResources(JSON.parse(content));
    if (!parsed.ok) throw new Error("a fixture that is not state");
    const put = await putState(
      backend.t.db,
      backend.keys,
      { organizationId: s.org.id, projectId: s.project.id, stackName },
      {
        serial,
        lineage: "L-web",
        content,
        createdBy: `ci:job-${serial}`,
        resources: parsed.resources,
      },
    );
    if (!put.ok) throw new Error(`fixture refused: ${put.reason}`);
    sizes[serial] = put.version.sizeBytes;
  }
  return sizes;
}

function mountPage(client: ReturnType<Backend["anonymous"]>) {
  render(
    <Providers client={client} queries={newQueryClient()}>
      <AuthGate>
        <OrgProvider>
          <RequireOrg>{(org) => <StatePage orgId={org.id} />}</RequireOrg>
        </OrgProvider>
      </AuthGate>
    </Providers>,
  );
}

const show = async (stack: string) => {
  const user = userEvent.setup();
  const input = await screen.findByLabelText("Stack");
  await user.clear(input);
  await user.type(input, stack);
  await user.click(screen.getByRole("button", { name: "Show state" }));
};
const versions = () => screen.findByRole("table", { name: "State versions" });
const resources = () => screen.findByRole("table", { name: "Resources in the newest version" });
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? undefined;
const rowHeaders = (t: HTMLElement) =>
  Array.from(t.querySelectorAll('th[scope="row"]')).map((h) => h.textContent);
const cellsOf = (t: HTMLElement) =>
  Array.from(t.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent),
  );
const failing = () =>
  Response.json(
    { type: "x", title: "Oops", status: 500, code: "internal", detail: "Try later." },
    { status: 500 },
  );

describe("the page", () => {
  test("is in the navigation, and asks for a stack before it asks the API anything", async () => {
    const s = await sceneOn(backend);
    const asked: string[] = [];
    mountPage(
      clientVia(backend.api, s.cookie, async (request, send) => {
        asked.push(pathOf(request));
        return send();
      }),
    );
    await screen.findByLabelText("Stack");
    expect(asked.filter((p) => p.includes("/state/"))).toEqual([]);
    expect(screen.queryByRole("table")).toBeNull();
    expect((screen.getByRole("button", { name: "Show state" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("is a page of the app, named State", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "State" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("State");
  });

  test("will not ask for a name the API would refuse", async () => {
    const s = await sceneOn(backend);
    const asked: string[] = [];
    mountPage(
      clientVia(backend.api, s.cookie, async (request, send) => {
        asked.push(pathOf(request));
        return send();
      }),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Stack"), "Bad Name");
    const button = screen.getByRole("button", { name: "Show state" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.clear(screen.getByLabelText("Stack"));
    await user.type(screen.getByLabelText("Stack"), "good-name");
    expect(button.disabled).toBe(false);
    expect(asked.filter((p) => p.includes("/state/"))).toEqual([]);
  });
});

describe("a stack with state", () => {
  test("lists the versions newest first: serial, when, size and who", async () => {
    const s = await sceneOn(backend);
    const sizes = await seed(s, "net", [1, 2, 3]);
    mountPage(s.client);
    await show("net");
    const t = await versions();
    expect(rowHeaders(t)).toEqual(["3", "2", "1"]);
    const rows = cellsOf(t);
    expect(rows.map((r) => r[1])).toEqual([
      `${sizes[3]} bytes`,
      `${sizes[2]} bytes`,
      `${sizes[1]} bytes`,
    ]);
    expect(rows.map((r) => r[2])).toEqual(["ci:job-3", "ci:job-2", "ci:job-1"]);
    expect(rows[0]?.[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  });

  test("lists what the newest version holds by name, and shows nothing the state holds", async () => {
    const s = await sceneOn(backend);
    await seed(s, "net", [1], [res("aws_vpc", "main")]);
    await seed(
      s,
      "net",
      [2],
      [res("aws_vpc", "main"), res("aws_subnet", "a", { module: "module.net" })],
    );
    mountPage(s.client);
    await show("net");
    const t = await resources();
    expect(rowHeaders(t).sort()).toEqual(["aws_vpc.main", "module.net.aws_subnet.a"]);
    const subnet = cellsOf(t).find((r) => r[0] === "aws_subnet");
    expect(subnet).toEqual(["aws_subnet", "registry.terraform.io/hashicorp/aws", "module.net"]);
    // the root module is no module at all, not an empty word
    expect(cellsOf(t).find((r) => r[0] === "aws_vpc")?.[2]).toBe("root");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("password");
  });

  test("shows every resource, past the first page of the list", async () => {
    const s = await sceneOn(backend);
    const many = Array.from({ length: 101 }, (_, i) => res("aws_vpc", `v${i}`));
    await seed(s, "big", [1], many);
    mountPage(s.client);
    await show("big");
    const t = await resources();
    expect(rowHeaders(t)).toHaveLength(101);
  });

  test("shows the stack that was asked for, and no other", async () => {
    const s = await sceneOn(backend);
    await seed(s, "one", [1], [res("aws_vpc", "first")]);
    await seed(s, "two", [7, 8], [res("aws_vpc", "second")]);
    mountPage(s.client);
    await show("one");
    expect(rowHeaders(await versions())).toEqual(["1"]);
    expect(rowHeaders(await resources())).toEqual(["aws_vpc.first"]);
    await show("two");
    await waitFor(() =>
      expect(rowHeaders(screen.getByRole("table", { name: "State versions" }))).toEqual(["8", "7"]),
    );
    await waitFor(() =>
      expect(
        rowHeaders(screen.getByRole("table", { name: "Resources in the newest version" })),
      ).toEqual(["aws_vpc.second"]),
    );
  });

  test("choosing another project of the organization shows that project's state", async () => {
    const s = await sceneOn(backend);
    const second = await createProject(backend.t.db, {
      organizationId: s.org.id,
      name: "acme/api",
    });
    await seed(s, "net", [1], [res("aws_vpc", "in-web")]);
    await seed({ ...s, project: second }, "net", [5], [res("aws_vpc", "in-api")]);
    mountPage(s.client);
    await screen.findByLabelText("Project");
    await show("net");
    expect(rowHeaders(await resources())).toEqual(["aws_vpc.in-web"]);
    await userEvent.setup().selectOptions(screen.getByLabelText("Project"), "acme/api");
    // the other project's page starts empty: it has not been asked for a stack yet
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    await show("net");
    await waitFor(() =>
      expect(
        rowHeaders(screen.getByRole("table", { name: "Resources in the newest version" })),
      ).toEqual(["aws_vpc.in-api"]),
    );
    expect(rowHeaders(screen.getByRole("table", { name: "State versions" }))).toEqual(["5"]);
  });

  test("a stack of another project is not shown", async () => {
    const s = await sceneOn(backend);
    const other = await sceneOn(backend);
    await seed(other, "net", [1, 2], [res("aws_vpc", "theirs")]);
    mountPage(s.client);
    await show("net");
    await screen.findByText(/No state for net in this project/);
    expect(document.body.textContent).not.toContain("theirs");
  });

  test("a stack that holds no resources says so", async () => {
    const s = await sceneOn(backend);
    await seed(s, "empty", [1], []);
    mountPage(s.client);
    await show("empty");
    await versions();
    await screen.findByText(/holds no resources/);
    expect(screen.queryByRole("table", { name: "Resources in the newest version" })).toBeNull();
  });

  test("a member who is not an admin can look too, and is told it is only a look", async () => {
    const s = await sceneOn(backend, { reporter: true });
    await seed(s, "net", [1], [res("aws_vpc", "main")]);
    mountPage(s.client);
    await show("net");
    await resources();
    expect(screen.getByText(/never the state itself/i)).toBeTruthy();
    // nothing here changes anything
    expect(
      screen.queryByRole("button", { name: /delete|roll back|restore|download|edit/i }),
    ).toBeNull();
  });
});

describe("a stack without state", () => {
  test("says there is none, and shows no table", async () => {
    const s = await sceneOn(backend);
    mountPage(s.client);
    await show("nothing-here");
    await screen.findByText(/No state for nothing-here in this project/);
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("when the API does not answer", () => {
  test("the versions failing are shown with a way to try again", async () => {
    const s = await sceneOn(backend);
    await seed(s, "net", [1], [res("aws_vpc", "main")]);
    let down = true;
    mountPage(
      clientVia(backend.api, s.cookie, async (request, send) =>
        down && pathOf(request).endsWith("/versions") ? failing() : send(),
      ),
    );
    await show("net");
    await waitFor(() => expect(alertText()).toContain("Try later."));
    down = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await versions();
    expect(alertText()).toBeUndefined();
  });

  test("the resources failing leave the versions on screen, and can be tried again", async () => {
    const s = await sceneOn(backend);
    await seed(s, "net", [1, 2], [res("aws_vpc", "main")]);
    let down = true;
    mountPage(
      clientVia(backend.api, s.cookie, async (request, send) =>
        down && pathOf(request).includes("/resources") ? failing() : send(),
      ),
    );
    await show("net");
    await waitFor(() => expect(alertText()).toContain("Try later."));
    expect(rowHeaders(await versions())).toEqual(["2", "1"]);
    down = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await resources();
    expect(alertText()).toBeUndefined();
  });

  test("a stack that is loading says so", async () => {
    const s = await sceneOn(backend);
    await seed(s, "net", [1]);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    mountPage(
      clientVia(backend.api, s.cookie, async (request, send) => {
        if (pathOf(request).endsWith("/versions")) await held;
        return send();
      }),
    );
    await show("net");
    await screen.findByText(/Loading state/);
    release();
    await versions();
    expect(screen.queryByText(/Loading state/)).toBeNull();
  });
});

describe("how the screen looks", () => {
  test("the lookup, the versions and the resources are each in a card", async () => {
    const s = await sceneOn(backend);
    await seed(s, "net", [1], [res("aws_vpc", "main")]);
    mountPage(s.client);
    expect((await screen.findByLabelText("Stack")).closest(".card")).not.toBeNull();
    await show("net");
    const v = await versions();
    // the resource addresses are long, so the cards take the whole page, not the narrow form column
    expect(v.closest(".stack")?.classList.contains("wide")).toBe(true);
    const r = await resources();
    expect(within(screen.getByRole("region", { name: "State versions" })).getByRole("table")).toBe(
      v,
    );
    expect(
      within(screen.getByRole("region", { name: "Resources in the newest version" })).getByRole(
        "table",
      ),
    ).toBe(r);
  });
});
