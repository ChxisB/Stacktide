import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// RDS-17: happy-dom has no layout, so only a real browser can say whether a screen is wider than a phone.
// Every screen, in both themes, at 390px: a wide table scrolls inside its card and never widens the page.
const PAGES = [
  "",
  "projects",
  "pipeline",
  "status",
  "state",
  "sync",
  "variables",
  "findings",
  "organizations",
  "settings",
];

for (const theme of ["light", "dark"]) {
  test(`no screen scrolls sideways at phone width, ${theme}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { session } = JSON.parse(readFileSync(`${import.meta.dirname}/.state.json`, "utf8"));
    await context.addCookies([{ name: "orch_session", value: session, url: String(baseURL) }]);
    await context.addInitScript((t) => localStorage.setItem("orch.theme", t), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of PAGES) {
      // a fresh load each time: a hash change in the same document is "idle" at once, before the data has arrived
      await page.goto("about:blank");
      await page.goto(`/#/${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
        clientWidth: document.scrollingElement?.clientWidth ?? 0,
      }));
      expect(scrollWidth, `/#/${path} is wider than the screen`).toBeLessThanOrEqual(clientWidth);
    }
  });
}

// VUI-2: the demo's Variables page was 505px wide on a 390px phone. The cause was a grid (`.stack`) whose one column
// grew to its widest child, so a table in a `.scroll` box widened the page instead of scrolling. The journey's values
// are short, so this makes every table wider than the phone, whatever the data, and the page must still fit.
test("a table wider than the phone scrolls inside its card and never widens the page", async ({
  page,
  context,
  baseURL,
}) => {
  const { session } = JSON.parse(readFileSync(`${import.meta.dirname}/.state.json`, "utf8"));
  await context.addCookies([{ name: "orch_session", value: session, url: String(baseURL) }]);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of PAGES) {
    await page.goto("about:blank");
    await page.goto(`/#/${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const tables = await page.evaluate(() => {
      const all = [...document.querySelectorAll("table")];
      for (const t of all) t.style.minWidth = "900px";
      return all.length;
    });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
      clientWidth: document.scrollingElement?.clientWidth ?? 0,
    }));
    expect(
      scrollWidth,
      `/#/${path} is wider than the screen with ${tables} wide table(s)`,
    ).toBeLessThanOrEqual(clientWidth);
  }
});

// VWS-6: the Variables page has two views, and the Secrets one has a row's details in a drawer (beside the list before VUI-6). Each view, with
// the details open, at a desktop and a phone width. It needs the project the journey makes (the files run in order, on
// one worker), so a page with no switch fails here and does not pass by showing nothing.
for (const theme of ["light", "dark"]) {
  test(`both variables views fit at desktop and phone width, ${theme}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { session } = JSON.parse(readFileSync(`${import.meta.dirname}/.state.json`, "utf8"));
    await context.addCookies([{ name: "orch_session", value: session, url: String(baseURL) }]);
    await context.addInitScript((t) => localStorage.setItem("orch.theme", t), theme);
    const sideways = () =>
      page.evaluate(
        () =>
          (document.scrollingElement?.scrollWidth ?? 0) >
          (document.scrollingElement?.clientWidth ?? 0),
      );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("about:blank");
      await page.goto("/#/variables");
      const environment = page.getByRole("button", { name: /^Environment/ });
      await expect(environment, "a project with environments (made by the journey)").toBeVisible();
      await expect(environment).toHaveText("dev");
      // its menu opens under the button and stays on the screen, on a phone too (VUI-8)
      await environment.click();
      const choices = page.getByRole("group", { name: "Environment" });
      await expect(choices).toBeVisible();
      const menu = await choices.boundingBox();
      if (!menu) throw new Error("the menu has a box");
      expect(menu.x, `the menu's left edge at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width, `the menu's right edge at ${width}px`).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(choices).toBeHidden();
      const list = page.getByRole("table", { name: "Variables in dev" });
      await expect(list).toBeVisible();
      expect(await sideways(), `the list at ${width}px`).toBe(false);
      // the controls above the list, and above the matrix (VUI-17): one row on a desktop; on a phone the search is a row to itself, first
      const toolbarFits = async (what: string) => {
        const tops = await page
          .locator(".toolbar > *")
          .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        const searchTop = await page
          .locator(".toolbar .search")
          .evaluate((e) => Math.round(e.getBoundingClientRect().top));
        if (width > 900)
          expect(new Set(tops).size, `rows of the toolbar of ${what} at ${width}px`).toBe(1);
        else {
          expect(Math.min(...tops), `the search is the first row of ${what}`).toBe(searchTop);
          expect(
            tops.filter((t) => t === searchTop),
            "and has it to itself",
          ).toHaveLength(1);
        }
      };
      await toolbarFits("the list");
      // with nothing open the list has the whole width, as the grid does (it is not left in two thirds of it)
      const card = (name: string) => page.getByRole("region", { name });
      const alone = (await card("Variables in dev").boundingBox())?.width ?? 0;

      // a row's details in a drawer over the list (VUI-6): at the right edge, the whole screen on a phone, the list not squeezed,
      // the page behind not scrolling, and Esc gives it all back
      await list.getByRole("button", { name: "API_KEY", exact: true }).click();
      const details = page.getByRole("dialog", { name: "API_KEY in dev" });
      await expect(details).toBeVisible();
      await expect(details.getByRole("region", { name: "API_KEY" })).toBeVisible();
      const of = await details.boundingBox();
      if (!of) throw new Error("the drawer has a box");
      expect(of.x + of.width, `the drawer's right edge at ${width}px`).toBeCloseTo(width, 0);
      expect(of.height, `the drawer's height at ${width}px`).toBeCloseTo(900, 0);
      if (width > 900) expect(of.width, "a panel, not the screen").toBeLessThan(width / 2);
      else expect(of.width, "the whole screen on a phone").toBeCloseTo(width, 0);
      expect(
        (await card("Variables in dev").boundingBox())?.width,
        "the list is not squeezed",
      ).toBeCloseTo(alone, -1);
      expect(
        await page.evaluate(() => getComputedStyle(document.body).overflow),
        "the page behind does not scroll",
      ).toBe("hidden");
      expect(await sideways(), `the list with details at ${width}px`).toBe(false);
      await page.keyboard.press("Escape");
      await expect(details).toBeHidden();
      await expect(
        list.getByRole("button", { name: "API_KEY", exact: true }),
        "focus is back on the name that was pressed",
      ).toBeFocused();

      // FLD-15: a folder opened from the list (the journey made /payments): the same card, its own rows, the path above
      // them and its details in the drawer; the crumb for the environment goes back to the root
      await page.getByRole("button", { name: "Open payments" }).click();
      const path = page.getByRole("navigation", { name: "Folder path" });
      await expect(path).toContainText("payments");
      await expect(list.getByRole("button", { name: "DATABASE_URL", exact: true })).toBeVisible();
      await expect(list.getByRole("button", { name: "API_KEY", exact: true })).toHaveCount(0);
      expect(
        (await card("Variables in dev").boundingBox())?.width,
        `a folder's list has the card's width at ${width}px`,
      ).toBeCloseTo(alone, -1);
      expect(await sideways(), `a folder's list at ${width}px`).toBe(false);
      await toolbarFits("a folder");
      await list.getByRole("button", { name: "DATABASE_URL", exact: true }).click();
      const inFolder = page.getByRole("dialog", { name: "DATABASE_URL in dev" });
      await expect(inFolder).toBeVisible();
      const drawer = await inFolder.boundingBox();
      if (!drawer) throw new Error("the folder's drawer has a box");
      expect(drawer.x + drawer.width, `the folder's drawer's right edge at ${width}px`).toBeCloseTo(
        width,
        0,
      );
      expect(await sideways(), `a folder's details at ${width}px`).toBe(false);
      await page.keyboard.press("Escape");
      await expect(inFolder).toBeHidden();
      await path.getByRole("button", { name: "dev" }).click();
      await expect(list.getByRole("button", { name: "API_KEY", exact: true })).toBeVisible();

      // VUI-11: with every row chosen the bar shows, the page still fits, and the confirm is a drawer that fits too; the
      // journey's person is an organization owner, so a page without the boxes fails here
      await list.getByRole("checkbox", { name: "Select all variables" }).check();
      const bar = page.getByRole("group", { name: "Selected variables" });
      await expect(bar).toBeVisible();
      expect(await sideways(), `the list with the bar at ${width}px`).toBe(false);
      await bar.getByRole("button", { name: "Delete selected" }).click();
      const confirm = page.getByRole("dialog", { name: /^Delete \d+ variables?$/ });
      await expect(confirm).toBeVisible();
      const at = await confirm.boundingBox();
      if (!at) throw new Error("the confirm has a box");
      expect(at.x + at.width, `the confirm's right edge at ${width}px`).toBeCloseTo(width, 0);
      expect(await sideways(), `the confirm at ${width}px`).toBe(false);
      await page.keyboard.press("Escape");
      await expect(confirm).toBeHidden();
      await list.getByRole("checkbox", { name: "Select all variables" }).uncheck();
      await expect(bar).toBeHidden();

      await environment.click();
      await page.getByRole("checkbox", { name: "All environments" }).check();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("table", { name: "Variables by environment" })).toBeVisible();
      const wide = (await card("Variables by environment").boundingBox())?.width;
      expect(wide, `the grid's card at ${width}px`).toBeCloseTo(alone, -1);
      expect(await sideways(), `the grid at ${width}px`).toBe(false);
      await toolbarFits("the matrix");
      // VUI-16: a column's menu opens whole, on the screen
      await page.getByRole("button", { name: "Options for dev" }).click();
      const columnMenu = page.getByRole("menu");
      await expect(columnMenu).toBeVisible();
      const m = await columnMenu.boundingBox();
      if (!m) throw new Error("the column menu has a box");
      expect(m.x, `the column menu's left edge at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(m.x + m.width, `the column menu's right edge at ${width}px`).toBeLessThanOrEqual(
        width,
      );
      await page.keyboard.press("Escape");
      await expect(columnMenu).toBeHidden();
      // VUI-17: a matrix wider than its card scrolls in its own box (the card around it does not move) and never widens
      // the page, and the names stay at the box's left edge while it is scrolled. It is made wider than any
      // screen here, whatever the data; a box without overflow-x has a scrollLeft that stays 0
      await page.evaluate(() => {
        for (const t of document.querySelectorAll<HTMLElement>(".matrix table"))
          t.style.minWidth = "2000px";
      });
      expect(await sideways(), `the wide matrix at ${width}px`).toBe(false);
      const scrolled = await page.locator(".matrix").evaluate((box) => {
        box.scrollLeft = 150; // not to the end: a sticky cell stops where its row ends, and the made-up width is the names' too
        const card = box.closest<HTMLElement>(".card");
        const name = box.querySelector("tbody th")?.getBoundingClientRect();
        const edge = box.getBoundingClientRect().left;
        const result = {
          scrolls: box.scrollLeft > 0,
          cardMoved: (card?.scrollLeft ?? 0) > 0,
          name: name ? Math.round(name.left - edge) : 99,
        };
        box.scrollLeft = 0;
        for (const t of box.querySelectorAll<HTMLElement>("table")) t.style.minWidth = "";
        return result;
      });
      expect(scrolled.scrolls, `the matrix scrolls inside its box at ${width}px`).toBe(true);
      expect(scrolled.cardMoved, `the card does not scroll at ${width}px`).toBe(false);
      expect(scrolled.name, `the names stay in view at ${width}px`).toBe(0);
      // a key's row opened: every environment's line is inside the card, and the page still does not scroll sideways (VUI-9)
      await page
        .getByRole("table", { name: "Variables by environment" })
        .getByRole("button", { name: "API_KEY", exact: true })
        .click();
      const lines = page.getByRole("list", { name: "API_KEY by environment" });
      await expect(lines.getByRole("listitem")).toHaveCount(2);
      const [inside, outer] = [
        await lines.boundingBox(),
        await card("Variables by environment").boundingBox(),
      ];
      if (!inside || !outer) throw new Error("the lines and the card have boxes");
      expect(inside.x, `the open row's left edge at ${width}px`).toBeGreaterThanOrEqual(outer.x);
      expect(
        inside.x + inside.width,
        `the open row's right edge at ${width}px`,
      ).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
      expect(await sideways(), `the open row at ${width}px`).toBe(false);
      // and with the box scrolled the lines stay in view: an environment's name is not carried off with the columns
      const held = await page.locator(".matrix").evaluate((box) => {
        for (const t of box.querySelectorAll<HTMLElement>("table")) t.style.minWidth = "2000px";
        box.scrollLeft = 150;
        const name = box.querySelector(".env-name")?.getBoundingClientRect();
        const edge = box.getBoundingClientRect();
        const result = name ? Math.round(name.left - edge.left) : -99;
        box.scrollLeft = 0;
        for (const t of box.querySelectorAll<HTMLElement>("table")) t.style.minWidth = "";
        return result;
      });
      expect(
        held,
        `the open row's names, in the box, when it is scrolled at ${width}px`,
      ).toBeGreaterThanOrEqual(0);
      // FLD-15: the matrix of the folder: its keys across the environments, in the same card, the page still fitting
      await page.getByRole("button", { name: "Open payments" }).click();
      const folderMatrix = page.getByRole("table", { name: "Variables by environment" });
      await expect(folderMatrix.getByRole("rowheader", { name: "DATABASE_URL" })).toBeVisible();
      await expect(folderMatrix.getByRole("rowheader", { name: "API_KEY" })).toHaveCount(0);
      expect(await sideways(), `the matrix of a folder at ${width}px`).toBe(false);
      await toolbarFits("the matrix of a folder");
    }
  });
}

// VUI-4: a row's ⋯ menu is fixed at its button, so the table that scrolls inside its card cannot cut it off, and it opens
// upward when the page ends before the menu does. The last row is the worst case; a short phone and a short desktop too.
// It needs the variables the journey makes, so a page with none fails here and does not pass by showing nothing.
test("a row's menu opens whole and on top, for the last row, at desktop and phone width and in a short window", async ({
  page,
  context,
  baseURL,
}) => {
  const { session } = JSON.parse(readFileSync(`${import.meta.dirname}/.state.json`, "utf8"));
  await context.addCookies([{ name: "orch_session", value: session, url: String(baseURL) }]);
  for (const [width, height] of [
    [1280, 900],
    [390, 700],
    [1280, 420],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("about:blank");
    await page.goto("/#/variables");
    const list = page.getByRole("table", { name: "Variables in dev" });
    await expect(list, "a project with variables (made by the journey)").toBeVisible();
    const last = list.getByRole("button", { name: /^More actions for / }).last();
    await last.scrollIntoViewIfNeeded();
    await last.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const seen = await menu.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { r: r.toJSON(), onTop: !!top && e.contains(top), w: innerWidth, h: innerHeight };
    });
    const at = `at ${width}x${height}`;
    expect(seen.r.x, `the menu's left edge ${at}`).toBeGreaterThanOrEqual(0);
    expect(seen.r.x + seen.r.width, `the menu's right edge ${at}`).toBeLessThanOrEqual(seen.w);
    expect(seen.r.y, `the menu's top ${at}`).toBeGreaterThanOrEqual(0);
    expect(seen.r.y + seen.r.height, `the menu's bottom ${at}`).toBeLessThanOrEqual(seen.h);
    expect(seen.onTop, `the menu is not under the card ${at}`).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(last, "focus is back on the button").toBeFocused();
  }
});

// FLW-5/6: a target's strip is Variables, a line for each environment, and the target: side by side on a desktop, one
// above the other on a phone, with a plan open or not, and it never widens the page. It needs the target the journey
// makes (mapped to one environment), so a page with no strip fails here and does not pass by showing nothing.
for (const theme of ["light", "dark"]) {
  test(`the sync strip fits at desktop and phone width, ${theme}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { session } = JSON.parse(readFileSync(`${import.meta.dirname}/.state.json`, "utf8"));
    await context.addCookies([{ name: "orch_session", value: session, url: String(baseURL) }]);
    await context.addInitScript((t) => localStorage.setItem("orch.theme", t), theme);
    const sideways = () =>
      page.evaluate(
        () =>
          (document.scrollingElement?.scrollWidth ?? 0) >
          (document.scrollingElement?.clientWidth ?? 0),
      );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("about:blank");
      await page.goto("/#/sync");
      const strip = page.locator(".sync-flow");
      await expect(strip, "a target with a mapping (made by the journey)").toBeVisible();
      await expect(strip).toContainText("dev → development");
      expect(await sideways(), `the strip at ${width}px`).toBe(false);

      // the plan's counts are on the lines
      await page.getByRole("button", { name: "Plan sync" }).click();
      await expect(strip).toContainText("Nothing to change");
      expect(await sideways(), `the strip with a plan at ${width}px`).toBe(false);

      const [from, to] = [
        await strip.locator(".sync-box").first().boundingBox(),
        await strip.locator(".sync-target").boundingBox(),
      ];
      if (!from || !to) throw new Error("the strip has a box at each end");
      if (width > 600)
        expect(to.x, "beside the variables").toBeGreaterThanOrEqual(from.x + from.width);
      else expect(to.y, "below the variables").toBeGreaterThanOrEqual(from.y + from.height);
    }
  });
}

// FRG-24: the repository address and the connection form (with GitHub chosen) fit beside their neighbours at desktop and
// phone width. The journey's GitLab connection is what puts the address form on the page.
for (const theme of ["light", "dark"]) {
  test(`the repository address and the connection form fit at desktop and phone width, ${theme}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { session } = JSON.parse(readFileSync(`${import.meta.dirname}/.state.json`, "utf8"));
    await context.addCookies([{ name: "orch_session", value: session, url: String(baseURL) }]);
    await context.addInitScript((t) => localStorage.setItem("orch.theme", t), theme);
    const sideways = () =>
      page.evaluate(
        () =>
          (document.scrollingElement?.scrollWidth ?? 0) >
          (document.scrollingElement?.clientWidth ?? 0),
      );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("about:blank");
      await page.goto("/#/projects");
      const address = page.getByRole("form", { name: "Repository address" });
      await expect(address, "the import card, from the journey's connection").toBeVisible();
      const box = await address.boundingBox();
      if (!box) throw new Error("the address form has a box");
      expect(box.x + box.width, `the address form at ${width}px`).toBeLessThanOrEqual(width);
      expect(await sideways(), `the address form at ${width}px`).toBe(false);

      await page.getByRole("button", { name: "Add a connection" }).click();
      await page.getByLabel("Forge").selectOption("github");
      await expect(page.getByRole("form", { name: "Connect GitHub" })).toBeVisible();
      expect(await sideways(), `the GitHub connection form at ${width}px`).toBe(false);
    }
  });
}
