import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

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

type Finding = { rule: string; where: string; detail: string };

// VUI-19: what makes a page look as if its parts float. Every page, both themes, 1280 and 390 wide, is measured, never
// judged by eye: (1) controls on one line with different heights or centre lines, (2) an icon off the centre of its
// button, (3) a column or a label list whose left edges differ from row to row, (4) text that starts away from its
// card's content edge, (5) something to press that does not change when the pointer is on it. The list is printed, kept
// in demo/shots/align-*.txt, and the test fails on any entry, so a finding is fixed in the shared rule or named as meant.

/** Runs in the page: rules 1 to 4, which need only the layout. */
function measureLayout(): Finding[] {
  const found: Finding[] = [];
  const TOL = 1.5;
  // a table that opening a row menu scrolled sideways would put its first column left of the card
  for (const box of document.querySelectorAll(".scroll")) box.scrollLeft = 0;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      !el.closest(".visually-hidden, [hidden], [aria-hidden='true']")
    );
  };
  const name = (el: Element) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 28);
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : ""}`;
  };
  const where = (el: Element) => {
    const card = el.closest(".card, dialog, .head, table, form");
    return `${card ? name(card) : "page"} > ${name(el)}`;
  };

  // (1) controls that share a line: same parent, vertically overlapping
  const CONTROL =
    "button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), a.button";
  const parents = new Set<Element>();
  for (const c of document.querySelectorAll(CONTROL)) {
    if (c.parentElement && visible(c)) parents.add(c.parentElement);
  }
  for (const parent of parents) {
    const kids = [...parent.children].filter((k) => k.matches(CONTROL) && visible(k));
    if (kids.length < 2) continue;
    const boxes = kids
      .map((k) => ({ k, r: k.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    const lines: (typeof boxes)[] = [];
    for (const b of boxes) {
      const line = lines.find((l) => b.r.top < (l[0] as (typeof boxes)[0]).r.bottom - 4);
      if (line) line.push(b);
      else lines.push([b]);
    }
    for (const line of lines) {
      if (line.length < 2) continue;
      const heights = line.map((b) => b.r.height);
      const centres = line.map((b) => b.r.top + b.r.height / 2);
      const dh = Math.max(...heights) - Math.min(...heights);
      const dc = Math.max(...centres) - Math.min(...centres);
      if (dh > TOL || dc > TOL)
        found.push({
          rule: "1 same line, different size",
          where: where(parent),
          detail: `${line.map((b) => `${name(b.k)} ${Math.round(b.r.height)}px`).join(" | ")} (heights differ ${dh.toFixed(1)}, centres ${dc.toFixed(1)})`,
        });
    }
  }

  // (2) an icon in the middle of its button
  for (const b of document.querySelectorAll("button, a")) {
    const svg = b.querySelector(":scope > svg");
    if (!svg || !visible(b) || (b.textContent ?? "").trim() !== "") continue;
    const br = b.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const dx = sr.left + sr.width / 2 - (br.left + br.width / 2);
    const dy = sr.top + sr.height / 2 - (br.top + br.height / 2);
    if (Math.abs(dx) > TOL || Math.abs(dy) > TOL)
      found.push({
        rule: "2 icon off centre",
        where: where(b),
        detail: `${dx.toFixed(1)}px across, ${dy.toFixed(1)}px down`,
      });
  }

  // (3) left edges of a column, and of a list of terms
  // where a cell's content starts to the eye: its first text, icon, field, or box with a background or border (a pill
  // starts at its own edge, not at its text)
  const textLeft = (el: Element) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL, {
      acceptNode: (n) => {
        if (n.nodeType === Node.TEXT_NODE)
          return (n.textContent ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        if (n.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_SKIP;
        const e = n as Element;
        if (e.closest(".visually-hidden, [aria-hidden='true']:not(svg)"))
          return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(e);
        // a picture laid over a field (the search icon) is part of the field, not where the content starts
        if (cs.position === "absolute") return NodeFilter.FILTER_REJECT;
        // a summary's arrow is part of it
        if (e.matches("svg, input, select, img, summary")) return NodeFilter.FILTER_ACCEPT;
        const box =
          (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") ||
          parseFloat(cs.borderLeftWidth) > 0;
        return box && e.getBoundingClientRect().width > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const n = walker.nextNode();
    if (!n) return undefined;
    if (n.nodeType === Node.ELEMENT_NODE) return (n as Element).getBoundingClientRect().left;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getClientRects()[0];
    return r && r.width > 0 ? r.left : undefined;
  };
  for (const table of document.querySelectorAll("table")) {
    if (!visible(table)) continue;
    const rows = [...table.querySelectorAll("tr")].filter(visible);
    const columns = new Map<number, number[]>();
    for (const row of rows) {
      const cells = [...row.children].filter((c) => c.matches("th, td"));
      // a row that spans or holds a panel (colspan) has no column of its own
      if (cells.some((c) => c.hasAttribute("colspan"))) continue;
      cells.forEach((cell, i) => {
        const x = textLeft(cell);
        if (x !== undefined && visible(cell)) columns.set(i, [...(columns.get(i) ?? []), x]);
      });
    }
    for (const [i, xs] of columns) {
      const spread = Math.max(...xs) - Math.min(...xs);
      if (xs.length > 1 && spread > 2)
        found.push({
          rule: "3 column edge",
          where: where(table),
          detail: `column ${i + 1}: text starts ${spread.toFixed(1)}px apart over ${xs.length} rows`,
        });
    }
  }
  for (const dl of document.querySelectorAll("dl")) {
    if (!visible(dl)) continue;
    for (const tag of ["dt", "dd"]) {
      const xs = [...dl.querySelectorAll(tag)]
        .filter(visible)
        .map(textLeft)
        .filter((x) => x !== undefined) as number[];
      const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
      if (spread > 2)
        found.push({
          rule: "3 column edge",
          where: where(dl),
          detail: `${tag}: ${spread.toFixed(1)}px apart`,
        });
    }
  }
  for (const form of document.querySelectorAll("form")) {
    if (!visible(form)) continue;
    const xs = [...form.querySelectorAll(":scope .field > label, :scope > label")]
      .filter(visible)
      .map(textLeft)
      .filter((x) => x !== undefined) as number[];
    const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    if (spread > 2)
      found.push({
        rule: "3 column edge",
        where: where(form),
        detail: `labels start ${spread.toFixed(1)}px apart`,
      });
  }

  // (6) a badge or pill in a line of text: its words and the words beside it share one line (an inline-flex box sits on
  // the bottom of its picture, so its words rode high). Only the same size of text is compared.
  const firstWords = (el: Element) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        (n.textContent ?? "").trim() && !(n.parentElement as Element).closest(".visually-hidden")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    return w.nextNode();
  };
  const centreOf = (n: Node) => {
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getClientRects()[0];
    return r && r.width > 0 ? r.top + r.height / 2 : undefined;
  };
  for (const box of document.querySelectorAll("*")) {
    if (!getComputedStyle(box).display.startsWith("inline-") || !visible(box)) continue;
    const inside = firstWords(box);
    if (!inside) continue;
    for (const side of [box.previousSibling, box.nextSibling]) {
      if (side?.nodeType !== Node.TEXT_NODE || !(side.textContent ?? "").trim()) continue;
      const a = centreOf(inside);
      const b = centreOf(side);
      const same =
        getComputedStyle(inside.parentElement as Element).fontSize ===
        getComputedStyle(box.parentElement as Element).fontSize;
      if (a === undefined || b === undefined || !same || Math.abs(a - b) > 12) continue;
      if (Math.abs(a - b) > TOL)
        found.push({
          rule: "6 words off the line",
          where: where(box),
          detail: `${name(box)}: its words are ${(a - b).toFixed(1)}px from the words beside it`,
        });
    }
  }

  // (4) text that starts at the card's content edge, not before or past it
  for (const card of document.querySelectorAll(".card, dialog .drawer-body")) {
    if (!visible(card)) continue;
    const cs = getComputedStyle(card);
    const edge =
      card.getBoundingClientRect().left +
      parseFloat(cs.borderLeftWidth) +
      parseFloat(cs.paddingLeft);
    for (const child of card.children) {
      if (
        !visible(child) ||
        child.matches(
          "table, .table-wrap, .scroll, .matrix, form, section, ul, ol, dl, .stack, .row",
        )
      )
        continue;
      const x = textLeft(child);
      if (x !== undefined && Math.abs(x - edge) > 2)
        found.push({
          rule: "4 not at the content edge",
          where: where(card),
          detail: `${name(child)} starts ${(x - edge).toFixed(1)}px from the edge`,
        });
    }
  }
  return found;
}

/** The look of an element that a pointer or the keyboard changes. */
const LOOK = [
  "backgroundColor",
  "color",
  "borderTopColor",
  "boxShadow",
  "textDecorationLine",
  "textDecorationThickness",
  "opacity",
  "transform",
  "outlineStyle",
  "filter",
] as const;

/** Runs in the page: marks one of each kind of thing to press and says what it is. */
function markPressables(): { id: string; label: string; cursor: string }[] {
  for (const old of document.querySelectorAll("[data-align]")) old.removeAttribute("data-align");
  const seen = new Set<string>();
  const out: { id: string; label: string; cursor: string }[] = [];
  const SEL =
    "button, a[href], [role=menuitem], [role=tab], summary, tbody tr[tabindex], [role=button]";
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (
      r.width === 0 ||
      r.height === 0 ||
      cs.visibility === "hidden" ||
      el.closest("[aria-hidden='true'], .visually-hidden")
    )
      continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
    // already "on": the page you are on, the filter that is chosen. It has nothing further to show.
    if (el.getAttribute("aria-current") || el.getAttribute("aria-pressed") === "true") continue;
    const kind = `${el.tagName}.${typeof el.className === "string" ? el.className : ""}.${el.getAttribute("role") ?? ""}`;
    if (seen.has(kind) || out.length >= 40) continue;
    seen.add(kind);
    const id = String(out.length);
    el.setAttribute("data-align", id);
    out.push({
      id,
      label: `${el.tagName.toLowerCase()}${kind.split(".")[1] ? `.${kind.split(".")[1]?.split(" ")[0]}` : ""} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`,
      cursor: cs.cursor,
    });
  }
  return out;
}

async function look(page: Page, id: string) {
  return page.evaluate(
    ([i, props]) => {
      const el = document.querySelector(`[data-align="${i}"]`);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return props.map((p) => `${p}=${cs[p as keyof CSSStyleDeclaration]}`).join(";");
    },
    [id, [...LOOK]] as [string, string[]],
  );
}

/** (5): each marked thing is pointed at, then given the keyboard; one that looks the same both times is a finding. */
async function measureHover(page: Page): Promise<Finding[]> {
  const found: Finding[] = [];
  const items = await page.evaluate(markPressables);
  for (const item of items) {
    const target = page.locator(`[data-align="${item.id}"]`);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Shift"); // so a script focus counts as the keyboard's
    const before = await look(page, item.id);
    const nothingFocused = await target.evaluate((el) => document.activeElement !== el);
    if (!nothingFocused) await target.evaluate((el) => (el as HTMLElement).blur());
    try {
      await target.hover({ timeout: 1500 });
    } catch {
      continue; // covered or scrolled away: not something to point at
    }
    const hovered = await look(page, item.id);
    await page.mouse.move(0, 0);
    await target.evaluate((el) => (el as HTMLElement).focus());
    const focused = await look(page, item.id);
    await target.evaluate((el) => (el as HTMLElement).blur());
    if (before === hovered)
      found.push({ rule: "5 no hover change", where: "page", detail: item.label });
    if (before === focused)
      found.push({ rule: "5 no focus change", where: "page", detail: item.label });
    if (item.cursor !== "pointer")
      found.push({
        rule: "5 no pointer cursor",
        where: "page",
        detail: `${item.label} (${item.cursor})`,
      });
  }
  return found;
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1280, 390]) {
    test(`alignment, ${theme}, ${width}px`, async ({ page }) => {
      const out = join(test.info().project.testDir, "shots");
      await mkdir(out, { recursive: true });
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto(`http://127.0.0.1:${PORT + 1}/`);
      const all: string[] = [];
      const add = (pageName: string, list: Finding[]) => {
        const keys = new Set<string>();
        for (const f of list) {
          const line = `${pageName} | ${f.rule} | ${f.where} | ${f.detail}`;
          if (!keys.has(line)) {
            keys.add(line);
            all.push(line);
          }
        }
      };
      for (const path of PAGES) {
        await page.goto(`${APP}/#/${path}`);
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        if (path === "state") {
          await page.getByLabel("Stack").fill("network");
          await page.getByRole("button", { name: "Show state" }).click();
          await page.getByRole("heading", { name: "Resources in the newest version" }).waitFor();
        }
        await page.waitForLoadState("networkidle");
        await expect(page.getByText(/^Loading/)).toHaveCount(0);
        add(path || "home", await page.evaluate(measureLayout));
        if (width === 1280) add(path || "home", await measureHover(page));
      }
      // the Variables page with a drawer open: its header, its panels and its footer are the part that was found floating
      await page.goto(`${APP}/#/variables`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      await page
        .getByRole("button", { name: /^More actions for / })
        .first()
        .click();
      // dispatched, not clicked: a real click scrolls the item into view and the menu closes on scroll, by design
      await page.getByRole("menuitem", { name: "Version history" }).dispatchEvent("click");
      await page.getByRole("list", { name: /^Versions of / }).waitFor();
      add("variables, history drawer", await page.evaluate(measureLayout));
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: /^More actions for / })
        .first()
        .click();
      // dispatched, not clicked: a real click scrolls the item into view and the menu closes on scroll, by design
      await page.getByRole("menuitem", { name: "Edit details" }).dispatchEvent("click");
      await page.locator("dialog.drawer").waitFor();
      add("variables, edit drawer", await page.evaluate(measureLayout));
      if (width === 1280) add("variables, edit drawer", await measureHover(page));
      await writeFile(join(out, `align-${theme}-${width}.txt`), `${all.join("\n")}\n`);
      console.log(`\n== ${theme} ${width}px: ${all.length} findings ==\n${all.join("\n")}`);
      expect(all, "alignment and hover findings").toEqual([]);
    });
  }
}
