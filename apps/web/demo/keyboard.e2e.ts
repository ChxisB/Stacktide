import { expect, type Locator, type Page, test } from "@playwright/test";

const PORT = Number(process.env.DEMO_PORT ?? 3210);
const APP = `http://127.0.0.1:${PORT}`;

// VUI-12: every action the Variables page has, done with the keyboard alone. Each control is reached by pressing Tab
// (arrows inside a menu) until it has focus, and used with Enter or Space; nothing is clicked and nothing is focused by
// the script, so a control that cannot be reached, or that does not answer a key, fails here. One line for each action
// says how many presses it took. Run it with `bun run demo:keys`.

/** Presses `key` until `target` has focus, and says how many presses it took. */
async function reach(page: Page, target: Locator, key = "Tab", limit = 150) {
  for (let n = 0; n <= limit; n++) {
    const found = await target.count();
    if (found > 1) throw new Error(`${target} is ${found} elements: name one`);
    if (found === 1 && (await target.evaluate((el) => el === document.activeElement))) return n;
    await page.keyboard.press(key);
  }
  throw new Error(`${limit} presses of ${key} never reached ${target}`);
}

test("every action of the Variables page, with the keyboard alone", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
  page.on(
    "response",
    (r) =>
      r.status() >= 400 &&
      !(r.status() === 404 && r.url().endsWith("/sso")) &&
      problems.push(`${r.status()} ${new URL(r.url()).pathname}`),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${PORT + 1}/`);

  const walked: string[] = [];
  const press = (key: string) => page.keyboard.press(key);
  const table = page.getByRole("table", { name: "Variables in dev" });
  const drawer = page.locator("dialog[open]");
  /** Starts an action from the top of a fresh page, so the count of presses is from the first control. */
  const start = async () => {
    await page.goto(`${APP}/#/variables`);
    await page.reload();
    await expect(table).toBeVisible();
  };
  const done = (action: string, presses: number) => walked.push(`${action}: ${presses} presses`);
  /** Opens an Add New item, by keys. */
  const addNew = async (item: string) => {
    let n = await reach(page, page.getByRole("button", { name: "Add New" }));
    await press("Enter");
    n += await reach(page, page.getByRole("menuitem", { name: item }), "ArrowDown");
    await press("Enter");
    return n;
  };
  /** Opens a row's ⋯ menu item, by keys. */
  const rowMenu = async (key: string, item: string) => {
    let n = await reach(page, page.getByRole("button", { name: `More actions for ${key}` }));
    await press("Enter");
    n += await reach(page, page.getByRole("menuitem", { name: item }), "ArrowDown");
    await press("Enter");
    return n;
  };
  const rowOf = (key: string) => table.getByRole("row").filter({ hasText: key });

  await test.step("add a variable", async () => {
    await start();
    const n = await addNew("Add a variable");
    const form = page.getByRole("dialog", { name: "New variable" });
    await expect(form).toBeVisible();
    await reach(page, form.getByLabel("Name"));
    await page.keyboard.type("KEYS_ADDED");
    await reach(page, form.getByLabel("Value"));
    await page.keyboard.type("typed-by-key");
    await reach(page, form.getByRole("button", { name: "Add variable" }));
    await press("Enter");
    await expect(drawer).toHaveCount(0);
    await expect(rowOf("KEYS_ADDED")).toBeVisible();
    done("add a variable", n);
  });

  await test.step("import variables", async () => {
    await start();
    const n = await addNew("Import variables");
    const form = page.getByRole("form", { name: "Import variables" });
    await expect(form).toBeVisible();
    await reach(page, form.getByRole("textbox").first());
    await page.keyboard.type("KEYS_IMPORTED=one");
    await reach(page, form.getByRole("button", { name: "Preview" }));
    await press("Enter");
    await reach(page, form.getByRole("button", { name: "Apply import" }));
    await press("Enter");
    await expect(page.getByRole("status", { name: "Import result" })).toBeVisible();
    await press("Escape");
    await expect(rowOf("KEYS_IMPORTED")).toBeVisible();
    done("import variables", n);
  });

  await test.step("edit a value", async () => {
    await start();
    const n = await reach(page, page.getByRole("button", { name: "Edit LOG_LEVEL", exact: true }));
    await press("Enter");
    const form = page.getByRole("form", { name: /^Edit / });
    await expect(form).toBeVisible();
    await reach(page, form.getByLabel("New value"));
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("warn");
    await reach(page, form.getByRole("button", { name: "Save" }));
    await press("Enter");
    await expect(drawer).toHaveCount(0);
    await expect(rowOf("LOG_LEVEL")).toContainText("warn");
    done("edit a value", n);
  });

  await test.step("history and restore", async () => {
    await start();
    const n = await rowMenu("LOG_LEVEL", "Version history");
    const history = page.getByRole("region", { name: "History of LOG_LEVEL" });
    await expect(history).toBeVisible();
    await reach(page, page.getByRole("button", { name: "Restore LOG_LEVEL to version 1" }));
    await press("Enter");
    const form = page.getByRole("form", { name: /^Restore / });
    await reach(page, form.getByRole("button", { name: "Restore version" }));
    await press("Enter");
    await press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(rowOf("LOG_LEVEL")).toContainText("info");
    done("history and restore", n);
  });

  await test.step("tags", async () => {
    await start();
    const n = await rowMenu("API_URL", "Add tags");
    const form = page.getByRole("form", { name: "Describe and tag API_URL" });
    await expect(form).toBeVisible();
    await reach(page, form.getByLabel("Tags", { exact: true }));
    await page.keyboard.type(" typed"); // after the tags it has: a space or a comma parts them
    await reach(page, form.getByRole("button", { name: "Save" }));
    await press("Enter");
    await expect(drawer).toHaveCount(0);
    await expect(rowOf("API_URL")).toContainText("typed");
    done("tags", n);
  });

  await test.step("override", async () => {
    await start();
    // API_URL's value comes from the project; the details drawer's Override makes one for this environment
    let n = await reach(page, table.getByRole("button", { name: "API_URL", exact: true }));
    await press("Enter");
    n += await reach(page, page.getByRole("button", { name: "Override" }));
    await press("Enter");
    const form = page.getByRole("form", { name: "Add a variable" });
    await expect(form).toBeVisible();
    await reach(page, form.getByLabel("Value"));
    await page.keyboard.type("https://dev.acme.example");
    await reach(page, form.getByRole("button", { name: "Add variable" }));
    await press("Enter");
    await expect(drawer).toHaveCount(0);
    // the form makes a secret unless told otherwise, so the value is masked; the source says it is dev's own now
    await expect(rowOf("API_URL")).toContainText("Environment");
    done("override", n);
  });

  await test.step("reveal one value", async () => {
    await start();
    let n = await reach(page, table.getByRole("button", { name: "DATABASE_URL", exact: true }));
    await press("Enter");
    n += await reach(page, page.getByRole("button", { name: "Reveal DATABASE_URL in dev" }));
    await press("Enter");
    await expect(drawer).toContainText("demo-not-a-real-secret");
    await press("Escape");
    done("reveal one value", n);
  });

  await test.step("reveal all, then hide", async () => {
    await start();
    const n = await reach(page, page.getByRole("button", { name: "Reveal all" }));
    await press("Enter");
    await expect(table).toContainText("demo-not-a-real-secret");
    await reach(page, page.getByRole("button", { name: "Hide all" }));
    await press("Enter");
    await expect(table).not.toContainText("demo-not-a-real-secret");
    done("reveal all", n);
  });

  await test.step("download the .env", async () => {
    await start();
    const n = await reach(page, page.getByRole("button", { name: "Download .env" }));
    const [file] = await Promise.all([page.waitForEvent("download"), press("Enter")]);
    expect(file.suggestedFilename()).toBe("acme-web-dev.env");
    done("download the .env", n);
  });

  await test.step("rotation", async () => {
    // setting a rotation is a command-line action (the panel says so), so the setup is by the API; the panel's own
    // actions, rotate now and switch off, are the keyboard's
    const list = async (path: string) =>
      (
        (await (await page.request.get(`${APP}${path}`)).json()) as {
          items: Record<string, string>[];
        }
      ).items;
    const [org] = await list("/organizations?limit=100");
    const projects = await list(`/organizations/${org?.id}/projects?limit=100`);
    const web = projects.find((p) => JSON.stringify(p).includes("acme/web"));
    const at = `/organizations/${org?.id}/projects/${web?.id}`;
    const dev = (await list(`${at}/environments?limit=100`)).find((e) => e.slug === "dev");
    const secret = (await list(`${at}/environments/${dev?.id}/variables?limit=100`)).find(
      (v) => v.key === "DATABASE_URL",
    );
    const set = await page.request.put(
      `${APP}${at}/environments/${dev?.id}/variables/${secret?.id}/rotation`,
      { data: { provider: "random", intervalDays: 30, graceDays: 0, enabled: true } },
    );
    expect(set.ok(), "the rotation is set for the walk").toBe(true);
    await start();
    let n = await rowMenu("DATABASE_URL", "Rotation");
    const region = page.getByRole("region", { name: "Rotation of DATABASE_URL" });
    await expect(region).toContainText("random, every 30 days");
    n += await reach(page, region.getByRole("button", { name: "Rotate now" }));
    await press("Enter");
    const form = page.getByRole("form", { name: "Rotate DATABASE_URL now" });
    await reach(page, form.getByRole("button", { name: "Rotate now" }));
    await press("Enter");
    await expect(region.getByRole("status")).toContainText("Rotated: DATABASE_URL is now version");
    await reach(page, region.getByRole("button", { name: "Switch off" }));
    await press("Enter");
    await expect(region).toContainText("Switched off");
    await press("Escape");
    done("rotation (rotate now, switch off)", n);
  });

  await test.step("changes", async () => {
    await start();
    const n = await reach(page, page.getByRole("button", { name: "Changes", exact: true }));
    await press("Enter");
    const changes = page.getByRole("dialog", { name: /^Changes in / });
    await expect(changes.getByRole("listitem").first()).toBeVisible();
    await press("Escape");
    await expect(drawer).toHaveCount(0);
    done("changes", n);
  });

  await test.step("delete a variable", async () => {
    await start();
    const n = await rowMenu("KEYS_ADDED", "Delete");
    const confirm = page.getByRole("alertdialog", { name: "Delete KEYS_ADDED" });
    await expect(confirm).toBeVisible();
    await reach(page, confirm.getByRole("button", { name: "Delete variable" }));
    await press("Enter");
    await expect(drawer).toHaveCount(0);
    await expect(rowOf("KEYS_ADDED")).toHaveCount(0);
    done("delete a variable", n);
  });

  await test.step("add an environment", async () => {
    await start();
    const n = await reach(page, page.getByRole("button", { name: /^Environment/ }));
    await press("Enter");
    await reach(page, page.getByRole("button", { name: "Add environment" }));
    await press("Enter");
    const form = page.getByRole("form", { name: "Add an environment" });
    await reach(page, form.getByLabel("New environment"));
    await page.keyboard.type("qa");
    await press("Enter");
    await expect(drawer).toHaveCount(0);
    // the page stays on dev; the new environment is in the menu, not ticked, and the focus is back on the button
    await press("Enter");
    await expect(page.getByRole("checkbox", { name: "qa" })).not.toBeChecked();
    await press("Escape");
    done("add an environment", n);
  });

  // UXR-12: at a phone width the sidebar is a menu; it opens onto Close, Escape gives the focus back, and a link chosen with keys closes it (last, as it leaves the phone viewport)
  await test.step("choose a page from the phone menu", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${APP}/#/projects`);
    await page.reload();
    const open = page.getByRole("button", { name: "Open menu" });
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(open).toBeVisible();
    let n = await reach(page, open);
    await press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Close menu" })).toBeFocused();
    await press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(open).toBeFocused();
    await press("Enter");
    n += await reach(page, menu.getByRole("link", { name: "Status", exact: true }));
    await press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page).toHaveURL(/#\/status$/);
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current]"),
    ).toHaveText("Status");
    done("choose a page from the phone menu", n);
  });

  console.log(`\nKeyboard-only walk:\n  ${walked.join("\n  ")}\n`);
  expect(problems, "a request was refused or a page crashed").toEqual([]);
});
