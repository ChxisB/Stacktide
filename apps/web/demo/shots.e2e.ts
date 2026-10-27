import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";

const PORT = Number(process.env.DEMO_PORT ?? 3210);
const APP = `http://127.0.0.1:${PORT}`;
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

/** The buttons of a dialog's footer that a box between them and the dialog clips at its bottom: a dialog that cuts its actions off. */
const footCut = (dialog: Locator) =>
  dialog.evaluate((d) => {
    const cut: string[] = [];
    for (const b of d.querySelectorAll(".drawer-foot button")) {
      const bottom = b.getBoundingClientRect().bottom;
      for (let p = b.parentElement; p && p !== d.parentElement; p = p.parentElement) {
        if (
          getComputedStyle(p).overflowY !== "visible" &&
          bottom > p.getBoundingClientRect().bottom + 0.5
        )
          cut.push(`${b.textContent} is cut by ${p.tagName}.${p.className}`);
      }
    }
    return cut;
  });

// Every page of the demo, in both themes, as a picture in demo/shots/. It also fails on what a viewer would
// notice: a page that crashed, a request that was refused, a console error, a page that scrolls sideways.
for (const theme of ["dark", "light"] as const) {
  test(`every page, ${theme}`, async ({ page }) => {
    const problems: string[] = [];
    const out = join(test.info().project.testDir, "shots");
    page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
    // the response listener names a refused request, so the browser's own line about it is not counted twice
    page.on(
      "console",
      (m) =>
        m.type() === "error" &&
        !m.text().startsWith("Failed to load resource") &&
        problems.push(`console: ${m.text()}`),
    );
    // an organization with no single sign-on set up answers 404, which the Settings page reads as "none"
    page.on(
      "response",
      (r) =>
        r.status() >= 400 &&
        !(r.status() === 404 && r.url().endsWith("/sso")) &&
        problems.push(`${r.status()} ${new URL(r.url()).pathname}`),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    // the app's own switch for no movement; the style below, added at load, takes the fades and transitions to their end
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    // reduced motion keeps the fades (UXR-7, UXR-10), so a picture taken the moment a page or overlay is there could be of the
    // first frame of its fade: every page of the demo starts with its animations and transitions at their end
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent =
          "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important}";
        document.head.append(style);
      });
    });
    await mkdir(out, { recursive: true });
    // the link signs in and sends the browser to the app
    await page.goto(`http://127.0.0.1:${PORT + 1}/`);

    for (const path of PAGES) {
      const name = path || "home";
      await page.goto(`${APP}/#/${path}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      // the Projects page names each project's forge: the one imported from GitHub (FRG-26) sits beside the two on GitLab
      if (path === "projects") {
        const forgeOf = (project: string) =>
          page
            .getByRole("row", { name: new RegExp(project) })
            .getByRole("cell")
            .nth(0);
        await expect(forgeOf("acme/mobile")).toHaveText("GitHub");
        await expect(forgeOf("acme/web")).toHaveText("GitLab");
        await expect(forgeOf("acme/api")).toHaveText("GitLab");
      }
      // the State page waits for a stack name, so give it one the seed wrote
      if (path === "state") {
        await page.getByLabel("Stack", { exact: true }).fill("network");
        await page.getByRole("button", { name: "Show state" }).click();
        await page.getByRole("heading", { name: "Resources in the newest version" }).waitFor();
      }
      // the Sync page with a plan open, so each environment's line of the strip carries its counts
      if (path === "sync") {
        await page.getByRole("button", { name: "Plan sync" }).click();
        await page
          .locator(".sync-lines")
          .getByText(/to change|to create|to delete/)
          .first()
          .waitFor();
      }
      // the Status page with two pipelines' jobs, one open at a time (UXR-18): a failed one (two passed, the one that failed and
      // why, the rest never run), then main's, whose release trigger started a child pipeline of two jobs and whose deploy-api
      // trigger handed over to acme/api, each drawn as a lane to the right
      if (path === "status") {
        await page.getByRole("button", { name: "Jobs feature/billing" }).click();
        await page.locator(".jobs-list").getByText("Script failure").waitFor();
        await page.screenshot({ path: join(out, `status-failed-${theme}.png`) });
        await page.getByRole("button", { name: "Jobs main" }).click();
        await page.getByRole("heading", { name: /^Child pipeline #\d+$/ }).waitFor();
        // its `deploy-api` trigger handed over to acme/api, which the viewer can see: that project's jobs are the second lane
        await page.getByRole("heading", { name: /^acme\/api #\d+$/ }).waitFor();
        await expect(
          page.locator(".job-flow"),
          "main's nodes are drawn, the failed pipeline's panel shut",
        ).toHaveCount(1);
        await expect(page.locator(".jobs-list").getByText("Script failure")).toHaveCount(0);
        await expect(page.locator(".job-trigger .job-kind")).toHaveText(["Triggers", "Triggers"]);
      }
      await page.waitForLoadState("networkidle");
      await expect(page.getByText(/^Loading/), `${name} is still loading`).toHaveCount(0);
      await expect(page.getByText("Something went wrong"), `${name} crashed`).toHaveCount(0);
      const sideways = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
      expect(await sideways(), `${name} scrolls sideways`).toBe(false);
      // a table wider than its card scrolls inside it, so the page check cannot see a control or a job the card cuts off
      const cutOff = (what: string) =>
        page.evaluate((selector) => {
          const edge =
            document.querySelector(".jobs-panel")?.closest(".card")?.getBoundingClientRect()
              .right ?? 0;
          return [...document.querySelectorAll(selector)]
            .filter((e) => e.getBoundingClientRect().right > edge + 0.5)
            .map((e) => e.textContent?.slice(0, 30) || e.tagName);
        }, what);
      // at a desktop width the table fits, so its buttons and links are in view; the box of nodes is in its card but scrolls
      // inside it when a lane makes the drawing wider (as it always does at a phone), so the nodes are checked by being
      // reachable instead
      const BESIDE_NODES =
        ".jobs-panel > :not(.job-flow), .jobs-panel > :not(.job-flow) *, .job-flow";
      // in each box the first node is in it, and scrolled to the end the last one is too (a lane is the last): a box that
      // does not scroll cuts the rest off
      const unreachable = () =>
        page.evaluate(() => {
          const boxes = [...document.querySelectorAll<HTMLElement>(".job-flow")];
          if (boxes.length === 0) return ["no nodes"];
          const edges = (n: Element) => n.getBoundingClientRect();
          const problems: string[] = [];
          for (const [i, box] of boxes.entries()) {
            const nodes = [...box.querySelectorAll(".jobs-list li")];
            if (nodes.length === 0) {
              problems.push(`box ${i} has no nodes`);
              continue;
            }
            const before = () => Math.min(...nodes.map((n) => edges(n).left)) - edges(box).left;
            const after = () => edges(box).right - Math.max(...nodes.map((n) => edges(n).right));
            if (before() < -0.5) problems.push(`the first node of box ${i} starts before its box`);
            box.scrollLeft = box.scrollWidth;
            if (after() < -0.5) problems.push(`the last node of box ${i} is out of reach`);
            box.scrollLeft = 0;
          }
          return problems;
        });
      if (path === "status") {
        expect(await cutOff(`${BESIDE_NODES}, table button, table a`), "cut off at 1280").toEqual(
          [],
        );
        expect(await unreachable(), "nodes out of reach at 1280").toEqual([]);
      }
      // the Deployments card (DEP-22), with what the seed gave acme/web: a box for each environment, in the order a build goes
      // through them, each with its numbers; none of them reaches past its card
      const card = page.getByRole("region", { name: "Deployments" });
      const boxesCutOff = () =>
        card.evaluate((c) => {
          const edge = c.getBoundingClientRect().right;
          return [...c.querySelectorAll(".deploy-box, .deploy-box *")]
            .filter((e) => e.getBoundingClientRect().right > edge + 0.5)
            .map((e) => e.textContent?.slice(0, 30) || e.tagName);
        });
      if (path === "status") {
        await expect(card.getByRole("heading", { level: 3 })).toHaveText([
          "dev",
          "staging",
          "production",
        ]);
        await expect(
          card.getByText("0.7 deployments a week · 1 failed in 4 · back in 10 min"),
        ).toBeVisible();
        await expect(
          card.getByText("0.5 deployments a week · 1 failed in 3 · back in -"),
        ).toBeVisible();
        await expect(card.getByText("Last attempt")).toBeVisible();
        expect(await boxesCutOff(), "deployment boxes cut off at 1280").toEqual([]);
      }
      // as tall as the page, so the sidebar (one screen high) reaches the bottom of the picture
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: 1280, height: Math.max(800, height) });
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      await page.setViewportSize({ width: 1280, height: 800 });
      // the same page on a phone (UXR-30), the whole length; Status takes its own below, with its jobs open
      if (path !== "status") {
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await sideways(), `${name} scrolls sideways at 390`).toBe(false);
        await page.screenshot({ path: join(out, `${name}-390-${theme}.png`), fullPage: true });
        // and the menu that stands in for the sidebar, open over home
        if (path === "") {
          await page.getByRole("button", { name: "Open menu" }).click();
          await page.getByRole("dialog", { name: "Menu" }).waitFor();
          await page.screenshot({ path: join(out, `menu-390-${theme}.png`) });
          await page.keyboard.press("Escape");
          await page.getByRole("dialog", { name: "Menu" }).waitFor({ state: "detached" });
        }
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      // the Promote dialog of staging, once the dry run has said what it would do: at a desktop and at a phone width
      if (path === "status") {
        await page.getByRole("button", { name: "Promote to staging" }).click();
        const dialog = page.getByRole("dialog", { name: "Promote to staging" });
        await dialog.getByText("Going there").waitFor();
        expect(await footCut(dialog), "the Promote dialog cuts off its buttons at 1280").toEqual(
          [],
        );
        await page.screenshot({ path: join(out, `status-promote-${theme}.png`) });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await sideways(), "the Promote dialog scrolls the page sideways at 390").toBe(false);
        await expect(dialog.getByRole("button", { name: "Start deployment" })).toBeVisible();
        expect(await footCut(dialog), "the Promote dialog cuts off its buttons at 390").toEqual([]);
        await page.screenshot({ path: join(out, `status-promote-390-${theme}.png`) });
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }
      // the Environment menu and its dialog, the Add New menu open, then the Add a variable drawer it opens over the list, with its advanced options closed, the rows chosen and the confirm they open, then the Changes drawer, then the matrix of every environment with a column's menu open and then a row open, and the matrix on a phone
      if (path === "variables") {
        // the Environment menu open, and the Add environment dialog it leads to
        await page.getByRole("button", { name: /^Environment/ }).click();
        await page.getByRole("group", { name: "Environment" }).waitFor();
        await page.screenshot({ path: join(out, `variables-envs-${theme}.png`) });
        await page.getByRole("button", { name: "Add environment" }).click();
        const adding = page.getByRole("dialog", { name: "Add environment" });
        await adding.waitFor();
        expect(await footCut(adding), "the Add environment dialog cuts off its buttons").toEqual(
          [],
        );
        await page.screenshot({ path: join(out, `variables-add-env-${theme}.png`) });
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Add New" }).click();
        await page.getByRole("menu", { name: "Add New" }).waitFor();
        await page.screenshot({ path: join(out, `variables-new-menu-${theme}.png`) });
        await page.getByRole("menuitem", { name: "Add a variable" }).click();
        await page.getByRole("dialog", { name: "New variable" }).waitFor();
        await page.screenshot({ path: join(out, `variables-add-${theme}.png`) });
        await page.keyboard.press("Escape");
        // two rows chosen, so the bar says how many; then the confirm it opens, which lists what goes and from where.
        // Cancelled, and the rows let go, so nothing is deleted and the shots after this one are as they were
        const boxes = page.getByRole("checkbox", { name: /^Select (?!all variables)/ });
        await boxes.nth(0).check();
        await boxes.nth(1).check();
        await page.getByRole("group", { name: "Selected variables" }).waitFor();
        await page.screenshot({ path: join(out, `variables-select-${theme}.png`) });
        await page.getByRole("button", { name: "Delete selected" }).click();
        await page.getByRole("alertdialog", { name: "Delete 2 variables" }).waitFor();
        await page.screenshot({ path: join(out, `variables-delete-${theme}.png`) });
        await page.keyboard.press("Escape");
        await boxes.nth(0).uncheck();
        await boxes.nth(1).uncheck();
        // the Changes drawer the strip's button opens: who changed which variable, newest first
        await page.getByRole("button", { name: "Changes", exact: true }).click();
        const changes = page.getByRole("dialog", { name: /^Changes in / });
        await changes.waitFor();
        await changes.getByRole("listitem").first().waitFor();
        await page.screenshot({ path: join(out, `variables-changes-${theme}.png`) });
        await page.keyboard.press("Escape");
        // every environment ticked: the matrix of marks, then one key's row opened and the pointer over a line, so its icons show
        await page.getByRole("button", { name: /^Environment/ }).click();
        await page.getByRole("checkbox", { name: "All environments" }).check();
        await page.keyboard.press("Escape");
        const grid = page.getByRole("table", { name: "Variables by environment" });
        // a column's menu open under its name
        await page
          .getByRole("button", { name: /^Options for / })
          .first()
          .click();
        await page.getByRole("menu").waitFor();
        await page.screenshot({ path: join(out, `variables-colmenu-${theme}.png`) });
        await page.keyboard.press("Escape");
        await grid.locator("tbody button[aria-expanded]").first().click();
        const lines = page.locator(".env-rows .env-line");
        await lines.first().waitFor();
        await lines.nth(1).hover();
        await expect(
          lines.nth(1).locator(".line-actions"),
          "a hovered line shows its icons",
        ).toBeVisible();
        await page.screenshot({ path: join(out, `variables-matrix-${theme}.png`) });
        expect(await sideways(), "the open matrix scrolls sideways").toBe(false);
        // the drawer's chrome, three ways: a line's details, its history, its edit form. The title, the line under it and
        // the X share the header; the title and the body's content start at one edge, the X and the content end at another
        const drawer = page.locator("dialog.drawer");
        const edges = async () =>
          drawer.evaluate((d) => {
            const box = (el: Element | null) => el?.getBoundingClientRect();
            const title = box(d.querySelector(".drawer-title"));
            const x = box(d.querySelector(".drawer-head button.icon svg"));
            const first = box(d.querySelector(".drawer-body > *"));
            const bar = box(d.querySelector(".drawer-head button.icon"));
            return {
              left: title && first ? Math.abs(title.left - first.left) : 99,
              right: x && first ? Math.abs(x.right - first.right) : 99,
              middle: title && bar ? Math.abs(title.top + 14 - (bar.top + bar.height / 2)) : 99,
            };
          });
        const open = async () => {
          await lines.nth(1).hover();
          await lines.nth(1).locator("button.env-value").click();
          await drawer.getByText("Version", { exact: true }).first().waitFor();
        };
        await open();
        await page.screenshot({ path: join(out, `variables-details-${theme}.png`) });
        const aligned = await edges();
        expect(aligned.left, "the title and the details start at one edge").toBeLessThan(2);
        expect(aligned.right, "the X and the details end at one edge").toBeLessThan(3);
        expect(aligned.middle, "the X sits on the title's first line").toBeLessThan(4);
        await drawer.getByRole("button", { name: /^History of / }).click();
        await page.getByRole("region", { name: /^History of / }).waitFor();
        await expect(page.getByText("Loading history…")).toHaveCount(0);
        await page.screenshot({ path: join(out, `variables-history-${theme}.png`) });
        await page.keyboard.press("Escape");
        await open();
        await drawer.getByRole("button", { name: /^Edit (?!description)/ }).click();
        await page.getByRole("form", { name: /^Edit / }).waitFor();
        await page.screenshot({ path: join(out, `variables-edit-${theme}.png`) });
        // the footer sits on the drawer's bottom edge, its buttons on the right: Cancel, then the one that saves
        const foot = await drawer.evaluate((d) => {
          const f = d.querySelector(".drawer-foot")?.getBoundingClientRect();
          const dr = d.getBoundingClientRect();
          const b = [...d.querySelectorAll(".drawer-foot button")].map((x) =>
            x.getBoundingClientRect(),
          );
          return {
            gap: f ? Math.abs(dr.bottom - f.bottom) : 99,
            flush: b.length && f ? Math.abs(f.right - 28 - (b.at(-1)?.right ?? 0)) : 99,
            order: [...d.querySelectorAll(".drawer-foot button")].map((x) => x.textContent),
          };
        });
        expect(foot.gap, "the footer rests on the drawer's bottom edge").toBeLessThan(2);
        expect(foot.flush, "the footer's last button ends at the gutter").toBeLessThan(2);
        expect(foot.order.at(0)).toBe("Cancel");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(out, `variables-edit-390-${theme}.png`) });
        expect(await sideways(), "the edit drawer scrolls sideways at 390").toBe(false);
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.keyboard.press("Escape");
        // the matrix on a phone: it scrolls in its own box, the page does not, and the names stay at the left
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator(".matrix").evaluate((box) => {
          box.scrollLeft = 120;
        });
        await page.screenshot({
          path: join(out, `variables-matrix-390-${theme}.png`),
          fullPage: true,
        });
        expect(await sideways(), "the matrix scrolls the page sideways at 390").toBe(false);
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      // the open jobs at phone width: the box of nodes scrolls inside the card, it does not widen the page
      if (path === "status") {
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await sideways(), "the open jobs scroll the page sideways at 390").toBe(false);
        expect(await cutOff(BESIDE_NODES), "jobs cut off by their card at 390").toEqual([]);
        expect(await unreachable(), "nodes out of reach at 390").toEqual([]);
        expect(await boxesCutOff(), "deployment boxes cut off at 390").toEqual([]);
        await page.screenshot({ path: join(out, `status-390-${theme}.png`), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    }
    expect(problems).toEqual([]);
  });
}
