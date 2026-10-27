import { expect, test } from "bun:test";
import { join } from "node:path";
import { SQUARE } from "./job-flow-layout";

const css = await Bun.file(join(import.meta.dir, "styles.css")).text();
const names = (block: string) => [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
const light = css.match(/:root\s*{([^}]*)}/)?.[1] ?? "";
const dark =
  css.match(
    /prefers-color-scheme:\s*dark\)\s*{\s*:root:not\(\[data-theme="light"\]\)\s*{([^}]*)}/,
  )?.[1] ?? "";
// dark chosen on the page (the theme toggle), which must say the same as a dark system
const forced = css.match(/:root\[data-theme="dark"\]\s*{([^}]*)}/)?.[1] ?? "";
const tokens = (block: string) =>
  Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]]));

test("dark chosen on the page sets exactly the tokens a dark system sets", () => {
  expect(Object.keys(tokens(dark)).length).toBeGreaterThan(5);
  expect(tokens(forced)).toEqual(tokens(dark));
});

test("a dark set overrides only tokens the light set defines, and every colour token has one", () => {
  const colours = names(light).filter((n) =>
    /#[0-9a-f]{3,8}\b/i.test(light.match(new RegExp(`${n}\\s*:\\s*([^;]*);`))?.[1] ?? ""),
  );
  expect(colours.length).toBeGreaterThan(5);
  expect(names(dark).length).toBeGreaterThan(0);
  for (const name of names(dark)) expect(names(light)).toContain(name);
  for (const name of colours) expect(names(dark)).toContain(name);
});

test("every var() names a token, and colours are written only in the token sets", () => {
  const defined = new Set(names(light));
  for (const [, used] of css.matchAll(/var\((--[\w-]+)\)/g))
    expect(defined.has(used ?? "")).toBe(true);
  const rest = css.replace(light, "").replace(dark, "").replace(forced, "");
  expect(rest.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
const value = (block: string, name: string) =>
  block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? "";

test("text, muted text, accent buttons and status colours are readable in both sets (WCAG AA, 4.5:1)", () => {
  for (const set of [light, `${light}${dark}`]) {
    // the dark set is read after the light one, so its values win
    const v = (name: string) => {
      const all = [...set.matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "gi"))];
      return all.at(-1)?.[1] ?? "";
    };
    for (const [fg, bg] of [
      ["--text", "--bg"],
      ["--text", "--surface"],
      ["--muted", "--surface"],
      ["--muted", "--bg"],
      ["--accent-text", "--accent"],
      ["--accent", "--surface"],
      ["--danger", "--surface"],
      ["--ok", "--surface"],
      ["--warn", "--surface"],
      ["--accent", "--bg"],
      ["--on-action", "--action"],
      ["--active", "--surface"],
      ["--idle", "--surface"],
      // text on the tints a badge, a chip or a banner sits on, and a status word on its own tint
      ["--text", "--raised"],
      ["--text", "--slate-tint"],
      ["--text", "--mint"],
      ["--text", "--sun-tint"],
      ["--text", "--aqua-tint"],
      ["--text", "--danger-tint"],
      ["--muted", "--slate-tint"],
      ["--muted", "--aqua-tint"],
      ["--ok", "--mint"],
      ["--warn", "--sun-tint"],
      ["--active", "--aqua-tint"],
      ["--danger", "--danger-tint"],
    ] as const) {
      expect(contrast(v(fg ?? ""), v(bg ?? ""))).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(value(light, "--text")).not.toBe("");
});

// the small buttons share one rule: a button in a table cell and `.small`
const SMALL = "td button,\ntd .button,\nbutton.small,\n.button.small";
// the rules a real browser showed to matter at 390px and at 1440px
// a selector's own rule: the line before it may not end in a comma, or it would be the tail of a list (`a,\nb {`)
const rule = (selector: string) =>
  css.match(
    new RegExp(`(?:^|(?<!,)\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`),
  )?.[1] ?? "";

test("tables fill the card they are in, and a card scrolls its own table on a narrow screen", () => {
  expect(rule("table")).not.toMatch(/max-width/);
  expect(rule(".card")).toMatch(/overflow-x:\s*auto/);
  // visually-hidden text is absolute; without a positioned card it escapes the scroll and widens the page
  expect(rule(".card")).toMatch(/position:\s*relative/);
  expect(css).toMatch(/@media \(max-width: 600px\)\s*{\s*\.card\s*{\s*padding:\s*16px/);
});

test("links and buttons in a table cell sit on one line, not one above the other's baseline", () => {
  expect(rule("td .row")).toMatch(/align-items:\s*center/);
});

test("a row header is the name of the row, so it keeps its case, as a branch or a variable is written", () => {
  const body = rule("tbody th");
  expect(body).toMatch(/text-transform:\s*none/);
  expect(body).toMatch(/letter-spacing:\s*normal/);
  expect(body).toMatch(/color:\s*var\(--text\)/);
});

test("a chosen filter chip keeps its colours under the pointer, so its label stays readable", () => {
  const hover = css.match(/\.chip\[aria-pressed="true"\]:hover[^{]*{([^}]*)}/)?.[1] ?? "";
  expect(hover).toMatch(/background:\s*var\(--action\)/);
});

// feature 24: a reference named in a note is marked, and the browser's yellow is not what shows
test("a marked reference sets its own colours, a pair that stays readable in both token sets", () => {
  const body = rule("mark");
  const fg = body.match(/(?:^|[\s;])color:\s*var\((--[\w-]+)\)/)?.[1] ?? "";
  const bg = body.match(/background:\s*var\((--[\w-]+)\)/)?.[1] ?? "";
  expect(fg).not.toBe("");
  expect(bg).not.toBe("");
  for (const set of [light, `${light}${dark}`]) {
    // the dark set is read after the light one, so its values win
    const v = (name: string) =>
      [...set.matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "gi"))].at(-1)?.[1] ?? "";
    expect(contrast(v(fg), v(bg))).toBeGreaterThanOrEqual(4.5);
  }
});

test("the variable list and a row's details sit side by side, and stack where the screen is narrow (VWS-4)", () => {
  expect(rule(".split")).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(0,\s*1fr\)/,
  );
  expect(rule(".split")).toMatch(/align-items:\s*start/);
  const narrow = css.match(/@media \(max-width: 900px\)\s*{[\s\S]*?\n}\n/)?.[0] ?? "";
  expect(narrow).toMatch(/\.split\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  // the same specificity, so the narrow rule only wins when it comes later (a real browser showed it did not)
  expect(css.indexOf(".split {\n  display: grid")).toBeLessThan(
    css.indexOf("@media (max-width: 900px)"),
  );
  // a name that opens the details is a word, not a pill
  expect(rule("th button.quiet")).toMatch(/font-weight:\s*inherit/);
});

// feature 23: the rhythm the real pages showed was missing (UXR-4 moved the inset 28 -> 24 and the gap 20 -> 16 to the Data board)
test("a card's parts are one gap apart, with no browser margin on top of it", () => {
  expect(rule(".card-flow")).toMatch(/gap:\s*16px/);
  expect(rule(".card-flow > *")).toMatch(/margin:\s*0/);
  expect(rule(".card")).toMatch(/padding:\s*24px/);
  expect(rule(".stack")).toMatch(/gap:\s*24px/);
});

test("a sub-heading in a card starts a section, with a rule above it", () => {
  expect(rule("h3")).toMatch(/font-size:/);
  expect(rule(".card-flow > h3")).toMatch(/border-top:\s*1px solid var\(--border\)/);
});

test("a field stops at a readable width, and a text area keeps the full one", () => {
  expect(css.match(/\ninput,\s*select,\s*textarea\s*{([^}]*)}/)?.[1]).toMatch(/max-width:\s*30rem/);
  expect(css.match(/\ntextarea\s*{\s*min-height[^}]*}/)?.[0]).toMatch(/max-width:\s*none/);
});

test("a row header keeps whole words, and a time never wraps", () => {
  expect(rule("tbody th")).toMatch(/overflow-wrap:\s*break-word/);
  expect(rule("tbody th")).not.toMatch(/overflow-wrap:\s*anywhere/);
  expect(rule("time")).toMatch(/white-space:\s*nowrap/);
});

// UXR-2: a button has no border of its own any more (the slate tile is its edge), so the compact one no longer sets a
// border colour; it takes the small corner instead, and `.small` shares the rule
test("table cells are roomy, and a button in one is compact: 32px, small type, the small corner", () => {
  // UXR-6 moved the cell from 10px to the Data board's 14px (a header keeps 12px, pinned below)
  expect(css.match(/\nth,\s*td\s*{([^}]*)}/)?.[1]).toMatch(/padding:\s*14px 16px/);
  const compact = rule(SMALL);
  expect(compact).toMatch(/min-height:\s*32px/);
  expect(compact).toMatch(/font-size:\s*13px/);
  expect(compact).toMatch(/border-radius:\s*var\(--r-sm\)/);
  expect(compact).not.toMatch(/border-color/);
});

// UXR-2: quiet is the board's ghost: no tile until it is pointed at, so it sets a transparent background where it set a
// transparent border (the border is transparent for every button now)
test("a quiet action is plain words: no tile, body text, Delete in the danger colour", () => {
  const quiet = rule("button.quiet");
  expect(quiet).toMatch(/background:\s*transparent/);
  expect(quiet).toMatch(/color:\s*var\(--text\)/);
  expect(quiet).toMatch(/padding:\s*0 6px/);
  expect(rule("button.quiet.danger")).toMatch(/color:\s*var\(--danger\)/);
});

// VUI-2: a grid's one column is as wide as its widest child unless the child may shrink, which made a wide table in a
// scroll box widen the whole page (505px on a 390px phone) instead of scrolling inside its card
test("a stack's children may shrink below their content, so a wide table scrolls in its box", () => {
  expect(rule(".stack > *")).toMatch(/min-width:\s*0\b/);
});

test("a stack keeps one rhythm: no margin on its children, and inside a card the card's own gap and section rule", () => {
  expect(rule(".stack > *")).toMatch(/margin:\s*0\b/);
  expect(rule(".stack.card")).toMatch(/gap:\s*16px/);
  expect(rule(".stack.card > h3")).toMatch(/border-top:\s*1px solid var\(--border\)/);
  // the card is already the width limit, so a stack in it spans it and its section rule meets the card's edges
  expect(rule(".card-flow > .stack")).toMatch(/max-width:\s*none/);
  // a form or section that opens with a heading is a section of the card too (Settings: Create a token)
  expect(rule(".card-flow > .stack > h3:first-child")).toMatch(
    /border-top:\s*1px solid var\(--border\)/,
  );
});

test("the Changes card is a plain list whose rows wrap: a sentence, its time, its level and its reason", () => {
  expect(rule(".changes")).toMatch(/list-style:\s*none/);
  expect(rule(".changes li")).toMatch(/flex-wrap:\s*wrap/);
});

test("a checklist step puts its hint under the link, and a row of text and a button is centred", () => {
  expect(rule(".checklist li > span")).toMatch(/display:\s*grid/);
  expect(rule(".row.middle")).toMatch(/align-items:\s*center/);
});

test("the actions of a table row keep each item whole and may wrap between them, so the column can give way", () => {
  expect(rule(".row.actions")).toMatch(/white-space:\s*nowrap/);
  expect(rule(".row.actions")).not.toMatch(/flex-wrap:\s*nowrap/);
  // a phone scrolls the table instead, so a row stays one line there
  expect(css).toMatch(/@media \(max-width: 600px\)\s*{\s*\.row\.actions\s*{\s*flex-wrap:\s*nowrap/);
});

test("a choice card keeps its title and its hint close, not a stack's gap apart", () => {
  expect(rule(".item > .stack")).toMatch(/gap:\s*4px/);
});

// FLW-3: the order of a plan's stacks is placed by the page, so its box must be a positioned one that
// holds a long name, and the row of boxes scrolls itself so it never widens the page
test("a run's graph scrolls inside its own box, places its boxes over its lines and keeps a long name to one line", () => {
  expect(rule(".run-graph")).toMatch(/overflow-x:\s*auto/);
  expect(rule(".run-graph")).toMatch(/max-width:\s*100%/);
  expect(rule(".run-graph-canvas")).toMatch(/position:\s*relative/);
  expect(rule(".run-graph-edges")).toMatch(/position:\s*absolute/);
  expect(rule(".run-graph-edge")).toMatch(/fill:\s*none/);
  expect(rule(".run-graph-edge")).toMatch(/stroke:\s*var\(--line-strong\)/);
  expect(rule(".run-graph-box")).toMatch(/position:\s*absolute/);
  expect(rule(".run-graph-box")).toMatch(/box-sizing:\s*border-box/);
  const name = rule(".run-graph-name");
  expect(name).toMatch(/text-overflow:\s*ellipsis/);
  expect(name).toMatch(/white-space:\s*nowrap/);
  expect(rule(".run-graph-box .row")).toMatch(/flex-wrap:\s*nowrap/);
  expect(rule(".plan-order > summary")).toMatch(/cursor:\s*pointer/);
});

// DEP-7: a box for each environment, as many to a line as fit and never wider than the card, with the last attempt set off under what is deployed
test("the deployment boxes fill the card without widening it, and the last attempt is set off", () => {
  expect(rule(".deploy-boxes")).toMatch(/list-style:\s*none/);
  expect(rule(".deploy-boxes")).toMatch(
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(18rem,\s*100%\),\s*1fr\)\)/,
  );
  expect(rule(".deploy-box")).toMatch(/border:\s*1\.5px solid var\(--line-strong\)/);
  expect(rule(".deploy-box")).toMatch(/padding:\s*16px/);
  expect(rule(".deploy-name")).toMatch(/margin:\s*0/);
  expect(rule(".deploy-box p")).toMatch(/margin:\s*0/);
  expect(rule(".deploy-last")).toMatch(/border-top:\s*1px solid var\(--border\)/);
});

// DEP-14, UXR-18: the dry-run answer of a promotion is ruled rows, the label at the left and the sha at the right
test("the dry-run answer of a promotion is ruled rows of a label and a sha", () => {
  expect(rule(".deploy-plan")).toMatch(/display:\s*grid/);
  expect(rule(".deploy-plan > div")).toMatch(/justify-content:\s*space-between/);
  expect(rule(".deploy-plan > div")).toMatch(/padding:\s*10px 0/);
  expect(rule(".deploy-plan > div")).toMatch(/border-bottom:\s*1px solid var\(--border\)/);
  expect(rule(".deploy-plan > div:first-child")).toMatch(/border-top:\s*1px solid var\(--border\)/);
});

// FLW-9: the jobs open under a row of a table: the panel is as wide as what shows and a long name breaks,
// so neither the table nor the page gets wider than the card (the nodes themselves are pinned under NOD-2)
test("the panel of a pipeline's jobs is marked off from the rows and as wide as what shows", () => {
  expect(rule(".jobs-panel")).toMatch(/border-left:\s*2px solid var\(--line-strong\)/);
  expect(rule(".jobs-panel")).toMatch(/white-space:\s*normal/);
  // as wide as the scrolling table's visible width, and kept at its left
  expect(rule(".jobs-host")).toMatch(/container-type:\s*inline-size/);
  expect(rule(".jobs-panel")).toMatch(/width:\s*100cqw/);
  expect(rule(".jobs-panel")).toMatch(/position:\s*sticky/);
  expect(rule(".jobs-stage")).toMatch(/text-transform:\s*uppercase/);
  expect(rule(".jobs-list")).toMatch(/list-style:\s*none/);
  expect(rule(".jobs-list code")).toMatch(/overflow-wrap:\s*anywhere/);
});

// FLW-5: a target's strip is boxes either side of labelled rules; the rules take the room between the
// boxes, and at phone width the strip stacks so it never widens the page
test("a target's flow puts its lines between two boxes, and stacks at phone width", () => {
  expect(rule(".sync-flow")).toMatch(/display:\s*flex/);
  expect(rule(".sync-box")).toMatch(/min-width:\s*0/);
  expect(rule(".sync-name")).toMatch(/overflow-wrap:\s*anywhere/);
  expect(rule(".sync-lines")).toMatch(/flex:\s*1/);
  expect(rule(".sync-lines li")).toMatch(/border-bottom:\s*2px solid var\(--line-strong\)/);
  expect(css).toMatch(
    /@media \(max-width: 600px\)\s*{\s*\.sync-flow\s*{\s*flex-direction:\s*column/,
  );
});

// UXR-20: what a plan does is counted in pills that wrap rather than widen the page, each a pill with
// its mark beside its words (the mark's own gap is the pill's)
test("a plan's counts are pills that wrap, with the mark beside the words", () => {
  expect(rule(".sync-counts")).toMatch(/flex-wrap:\s*wrap/);
  expect(rule(".sync-count")).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  expect(rule(".sync-count")).toMatch(/white-space:\s*nowrap/);
  expect(rule(".sync-count")).toMatch(/min-height:\s*36px/);
  expect(rule(".sync-count .op")).toMatch(/margin-right:\s*0/);
});

// NOD-2: the jobs as nodes are placed by the page, so each node is a box of a fixed size whose square is the
// size the layout assumes, a long name is clamped inside it, the row of columns scrolls itself, and the
// running mark turns only for a reader who has not asked for less motion
test("the jobs as nodes sit over their lines, keep to the size the layout assumes and scroll in their own box", () => {
  const flow = rule(".job-flow");
  expect(flow).toMatch(/overflow-x:\s*auto/);
  expect(flow).toMatch(/max-width:\s*100%/);
  expect(flow).toMatch(/min-width:\s*0/);
  expect(rule(".job-flow-canvas")).toMatch(/position:\s*relative/);
  expect(rule(".job-flow-edges")).toMatch(/position:\s*absolute/);
  expect(rule(".job-flow-edge")).toMatch(/fill:\s*none/);
  expect(rule(".job-flow-edge")).toMatch(/stroke:\s*var\(--line-strong\)/);
  expect(rule(".job-flow-junction,\n.job-flow-arrow path")).toMatch(/fill:\s*var\(--line-strong\)/);
  expect(rule(".job-stage")).toMatch(/position:\s*absolute/);
  expect(rule(".job-flow .jobs-stage")).toMatch(/text-overflow:\s*ellipsis/);
  const node = rule(".job-flow .jobs-list li");
  expect(node).toMatch(/box-sizing:\s*border-box/);
  expect(node).toMatch(/flex-direction:\s*column/);
  // a column that wrapped would put the rest of a node in a second column
  expect(node).toMatch(/flex-wrap:\s*nowrap/);
  expect(node).toMatch(/overflow:\s*hidden/);
  const name = rule(".job-flow code");
  expect(name).toMatch(/-webkit-line-clamp:\s*2/);
  expect(name).toMatch(/overflow:\s*hidden/);
  expect(name).toMatch(/overflow-wrap:\s*anywhere/);
  expect(rule(".job-flow .error")).toMatch(/-webkit-line-clamp:\s*2/);
});

test("the mark of a node with its padding and border is the square the lines point at, and a failed one has a red ring", () => {
  const g = rule(".job-flow .glyph");
  const px = (prop: string) => Number(g.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*(\\d+)px`))?.[1]);
  expect(g).toMatch(/box-sizing:\s*content-box/);
  expect(px("width") + 2 * px("padding") + 2 * Number(g.match(/border:\s*(\d+)px/)?.[1])).toBe(
    SQUARE,
  );
  expect(px("height")).toBe(px("width"));
  expect(rule(".job-flow .st-bad .glyph")).toMatch(/border-color:\s*var\(--danger\)/);
});

test("a running node's mark turns, and only where motion is welcome", () => {
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: no-preference\)\s*{\s*\.job-flow \.st-active \.g-half\s*{[^}]*animation:\s*job-spin/,
  );
  // outside that block the rule has no animation
  expect(
    css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*{\s*\.job-flow[^}]*}\s*}/, ""),
  ).not.toMatch(/animation:\s*job-spin/);
  expect(css).toMatch(/@keyframes job-spin/);
});

// NOD-7: a trigger is a node with a dashed ring and a kind line, its note is clamped like a reason, and a
// lane has a heading of its own (it sits in the same box, so no new rule for the width of the page)
test("a trigger's mark has a dashed ring, and its kind line, its note and a lane's heading have a look of their own", () => {
  expect(rule(".job-flow .job-trigger .glyph")).toMatch(/border-style:\s*dashed/);
  const kind = rule(".job-flow .job-kind");
  expect(kind).toMatch(/text-transform:\s*uppercase/);
  expect(kind).toMatch(/color:\s*var\(--muted\)/);
  const note = rule(".job-flow .job-note");
  expect(note).toMatch(/-webkit-line-clamp:\s*2/);
  expect(note).toMatch(/color:\s*var\(--muted\)/);
  const title = rule(".job-flow .job-lane-title");
  expect(title).toMatch(/text-align:\s*left/);
  expect(title).toMatch(/border-bottom:\s*1px dashed var\(--border\)/);
});

// VUI-2: the controls above a list are one flex row that wraps only when it must; the search takes what the
// rest leaves; a popover opens under its button (over a phone's whole row), above what it covers
test("the toolbar is one row that wraps only when the room is gone, and the search takes what is left", () => {
  const bar = rule(".toolbar");
  expect(bar).toMatch(/display:\s*flex/);
  expect(bar).toMatch(/flex-wrap:\s*wrap/);
  expect(bar).toMatch(/align-items:\s*center/);
  const search = rule(".toolbar .search");
  expect(search).toMatch(/flex:\s*1 1 \d+(\.\d+)?rem/);
  expect(search).toMatch(/min-width:\s*0/);
  expect(search).toMatch(/position:\s*relative/);
  // the field fills its box (the base rule caps inputs at 30rem) and leaves room for the magnifier
  const field = rule(".toolbar .search input");
  expect(field).toMatch(/width:\s*100%/);
  expect(field).toMatch(/max-width:\s*none/);
  expect(field).toMatch(/padding-left:\s*\d+px/);
  const lens = rule(".toolbar .search .ico");
  expect(lens).toMatch(/position:\s*absolute/);
  expect(lens).toMatch(/pointer-events:\s*none/);
});

test("on a phone the search is a row of its own, above the rest", () => {
  const phone =
    css.match(/@media \(max-width: 600px\)\s*{\s*\.toolbar \.search\s*{([^}]*)}/)?.[1] ?? "";
  expect(phone).toMatch(/order:\s*-1/);
  expect(phone).toMatch(/flex-basis:\s*100%/);
});

test("an icon button is a square as tall as any button, and its mark has no word beside it", () => {
  const icon = rule("button.icon");
  expect(icon).toMatch(/width:\s*44px/);
  expect(icon).toMatch(/padding:\s*0/);
});

test("a popover's panel opens under its button, above what it covers, in the card's own colours", () => {
  expect(rule(".popover")).toMatch(/position:\s*relative/);
  const panel = rule(".popover-panel");
  expect(panel).toMatch(/position:\s*absolute/);
  expect(panel).toMatch(/z-index:\s*\d+/);
  expect(panel).toMatch(/background:\s*var\(--surface\)/);
  expect(panel).toMatch(/border:\s*1px solid var\(--line-strong\)/);
  // a phone has no room beside the button: the panel spans the toolbar instead
  const phone =
    css.match(
      /@media \(max-width: 600px\)\s*{[^@]*?\.popover\s*{([^}]*)}[^@]*?\.popover-panel\s*{([^}]*)}/,
    ) ?? [];
  expect(phone[1]).toMatch(/position:\s*static/);
  expect(phone[2]).toMatch(/right:\s*0/);
  expect(rule(".toolbar")).toMatch(/position:\s*relative/);
});

// VUI-3: the strip above the table: the path on the left, Reveal all on the right, wrapping on a phone
test("the strip puts its path and its actions at the two ends and wraps rather than widening the card", () => {
  const strip = rule(".strip");
  expect(strip).toMatch(/display:\s*flex/);
  expect(strip).toMatch(/justify-content:\s*space-between/);
  expect(strip).toMatch(/flex-wrap:\s*wrap/);
  // a long project path breaks inside the strip
  expect(rule(".strip .path")).toMatch(/overflow-wrap:\s*anywhere/);
});

test("a secret's key mark is small, quiet and level with the name beside it", () => {
  const mark = rule(".key-mark");
  expect(mark).toMatch(/color:\s*var\(--muted\)/);
  expect(mark).toMatch(/display:\s*inline-flex/);
  // a fixed width, empty or not, so the names of secret and plain rows start at the same place
  expect(mark).toMatch(/width:\s*16px/);
  expect(rule(".key-mark .ico")).toMatch(/width:\s*16px/);
});

// UXR-22 (moved from VUI-4): a row's buttons are always shown. Feature 30 hid them until the row was pointed at or
// worked in (SPEC question 8 takes that away): a touch screen and a keyboard user see what a pointer user finds by hovering.
test("a row's buttons are always shown: no opacity trick and no hover rule, still on one line at the right", () => {
  const actions = rule("td.row-actions");
  expect(actions).not.toMatch(/opacity/);
  expect(actions).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  expect(actions).toMatch(/white-space:\s*nowrap/);
  expect(actions).toMatch(/text-align:\s*right/);
  expect(css).not.toMatch(/td\.row-actions\s*{[^}]*opacity:\s*0/);
  expect(css).not.toMatch(/tr:hover td\.row-actions|tr:focus-within td\.row-actions/);
  // the picture buttons of a row are as tall as the row's other buttons
  expect(rule(".row-actions button.icon")).toMatch(/width:\s*32px/);
});

// UXR-24: a finding's path is the longest thing in its table. It breaks after a slash (the <wbr>s) and, for one name wider than
// the column, anywhere, and it is held to a measure, so it wraps on a phone and on a desktop and never widens the table.
test("a finding's path wraps: a measure, and a break anywhere when a name is wider than it", () => {
  const path = rule("th.where code");
  expect(path).toMatch(/overflow-wrap:\s*anywhere/);
  expect(path).toMatch(/max-width:\s*30ch/);
  expect(path).toMatch(/display:\s*block/);
  // who dismissed it is held to the same measure: the id may break anywhere, the time stays whole
  expect(rule(".note")).toMatch(/max-width:\s*30ch/);
  expect(rule(".note code")).toMatch(/overflow-wrap:\s*anywhere/);
  expect(rule(".note time")).toMatch(/white-space:\s*nowrap/);
  expect(rule(".note-reason")).toMatch(/max-width:\s*30ch/);
});

// UXR-25: the Organizations forms. Fields share a line as far as they fit (a phone gets one to a line, with no media query), and
// delete organization sits apart under a rule at the foot of its card.
test("a form's fields share a line as far as they fit, and the delete button sits apart under a rule", () => {
  const fields = rule(".fields");
  expect(fields).toMatch(/display:\s*grid/);
  expect(fields).toMatch(
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(14rem,\s*100%\),\s*1fr\)\)/,
  );
  expect(fields).toMatch(/gap:\s*16px 24px/);
  expect(fields).toMatch(/align-items:\s*start/);
  expect(rule(".card-foot")).toMatch(/border-top:\s*1px solid var\(--border\)/);
  expect(rule(".card-foot")).toMatch(/padding-top:\s*20px/);
  expect(rule(".scroll + .card-foot")).toMatch(/border-top:\s*0/);
  expect(rule(".card-foot .stack")).toMatch(/display:\s*flex/);
});

// UXR-27: a role rule of the identity provider is a box of its own.
test("a role rule is a box with the medium radius, its three fields in a line", () => {
  expect(rule(".rule-card")).toMatch(/border:\s*1px solid var\(--border\)/);
  expect(rule(".rule-card")).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(rule(".rule-card-cols")).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1\.3fr\)\s+minmax\(0,\s*0\.9fr\)/,
  );
  // found by the picture: without this the claim input ran under the value input
  expect(rule(".rule-card-cols label")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

// UXR-28: the sign-in link, the new-token form and the token shown once.
test("creating a token is three fields in a line with the scopes widest, one to a line on a phone", () => {
  expect(rule(".token-form")).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1\.4fr\)\s+minmax\(0,\s*0\.7fr\)/,
  );
  // each field is one shrinking column, or a long input would run under its neighbour
  expect(rule(".token-form > *")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  expect(css).toMatch(
    /@media \(max-width: 600px\)\s*{\s*\.token-form\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  expect(rule(".link-row label")).toMatch(/flex:\s*1 1 16rem/);
  expect(rule(".link-row label")).toMatch(/max-width:\s*28rem/);
});

test("the token shown once is a bordered slate box with its value in the mono face", () => {
  const box = rule(".fresh-token");
  expect(box).toMatch(/border:\s*1px solid var\(--line-strong\)/);
  expect(box).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(box).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(rule(".token-value")).toMatch(/font-family:\s*var\(--mono\)/);
  // the value is not cut at the field's usual width
  expect(rule(".token-value")).toMatch(/max-width:\s*none/);
  // many scopes wrap between scopes in their cell, never inside one (`anywhere` let a phone squeeze the column to a letter)
  expect(rule("td.scopes")).toMatch(/overflow-wrap:\s*break-word/);
  expect(rule("td.scopes")).not.toMatch(/overflow-wrap:\s*anywhere/);
});

test("the ⋯ menu is fixed over the page (a scrolling table cannot clip it), above its card, in the card's own colours", () => {
  const menu = rule(".menu");
  expect(menu).toMatch(/position:\s*fixed/);
  expect(menu).toMatch(/z-index:\s*\d+/);
  expect(menu).toMatch(/background:\s*var\(--surface\)/);
  expect(menu).toMatch(/border:\s*1px solid var\(--line-strong\)/);
  expect(menu).toMatch(/min-width:\s*\d+(\.\d+)?rem/);
  // an item reads as a line of the menu, not as a pill: left-aligned, the width of the menu, no outline
  const item = rule(".menu button");
  expect(item).toMatch(/justify-content:\s*flex-start/);
  expect(item).toMatch(/width:\s*100%/);
  expect(item).toMatch(/border-color:\s*transparent/);
  expect(rule(".menu button.danger")).toMatch(/color:\s*var\(--danger\)/);
});

// VUI-5: the quick-add row is one line of two fields and a button, and wraps on a phone rather than widening the card
test("the quick-add row shares its line between its two fields, and wraps when the room is gone", () => {
  const row = rule(".quick-add");
  expect(row).toMatch(/display:\s*flex/);
  expect(row).toMatch(/flex-wrap:\s*wrap/);
  expect(row).toMatch(/align-items:\s*center/);
  // an input is 30rem wide at most elsewhere; here each takes what is left, and may shrink below its content
  const field = rule(".quick-add input");
  expect(field).toMatch(/flex:\s*1 1 \d+(\.\d+)?rem/);
  expect(field).toMatch(/min-width:\s*0/);
  expect(field).toMatch(/max-width:\s*none/);
});

// VUI-6: a drawer is a panel fixed to the right edge, over everything, as wide as 36rem but never wider than the screen
// (so it is the whole screen on a phone), with its own scrolling body, so the page behind stays where it is.
test("the drawer is fixed at the right edge, full height, no wider than the screen, over the menus, and scrolls its own body", () => {
  const layer = rule(".drawer-layer");
  expect(layer).toMatch(/position:\s*fixed/);
  expect(layer).toMatch(/inset:\s*0\s*;/);
  const z = (r: string) => Number(r.match(/z-index:\s*(\d+)/)?.[1]);
  expect(z(layer)).toBeGreaterThan(z(rule(".menu")));
  const drawer = rule(".drawer");
  expect(drawer).toMatch(/position:\s*fixed/);
  expect(drawer).toMatch(/inset:\s*0 0 0 auto/);
  expect(drawer).toMatch(/width:\s*min\(\d+(\.\d+)?rem,\s*100%\)/);
  expect(drawer).toMatch(/height:\s*100%/);
  // a <dialog> comes with a border, padding, a margin and a colour of its own
  expect(drawer).toMatch(/margin:\s*0/);
  expect(drawer).toMatch(/padding:\s*0/);
  expect(drawer).toMatch(/background:\s*var\(--surface\)/);
  expect(drawer).toMatch(/color:\s*var\(--text\)/);
  expect(drawer).toMatch(/max-width:\s*none/);
  expect(rule(".drawer-body")).toMatch(/overflow-y:\s*auto/);
  expect(rule(".drawer-body")).toMatch(/min-height:\s*0/);
});

test("the scrim covers the page, dims it with a token, and keeps its look when pointed at", () => {
  const scrim = rule("button.drawer-scrim");
  expect(scrim).toMatch(/position:\s*absolute/);
  expect(scrim).toMatch(/inset:\s*0\s*;/);
  expect(scrim).toMatch(/background:\s*var\(--scrim\)/);
  // the page's buttons get a pale fill when pointed at; a whole-screen one must not flash
  expect(rule("button.drawer-scrim:hover:not(:disabled)")).toMatch(/background:\s*var\(--scrim\)/);
  expect(light).toMatch(/--scrim:/);
});

test("what a drawer holds is not a card inside a card: its cards lose their box, and parts are told apart by a rule", () => {
  const card = rule(".drawer .card");
  expect(card).toMatch(/border:\s*0/);
  expect(card).toMatch(/padding:\s*0/);
  expect(card).toMatch(/background:\s*transparent/);
  expect(rule(".drawer-body > * + *")).toMatch(/border-top:\s*1px solid var\(--border\)/);
});

// VUI-18: the drawer's chrome: one gutter for header, body and footer; the X on the title's line; a form's footer at the bottom
test("a drawer's header, body and footer share one gutter, which is narrower at a phone's width", () => {
  expect(light).toMatch(/--drawer-pad:\s*28px/);
  expect(rule(".drawer-head")).toMatch(/padding:\s*20px var\(--drawer-pad\) 16px/);
  expect(rule(".drawer-body")).toMatch(/padding:\s*24px var\(--drawer-pad\)/);
  expect(rule(".drawer-foot")).toMatch(/padding:\s*16px var\(--drawer-pad\)/);
  expect(css).toMatch(/@media \(max-width: 600px\) \{\s*\.drawer \{\s*--drawer-pad:\s*16px/);
});

test("the header puts the X on the title's first line and the sub line under the title in the muted colour", () => {
  expect(rule(".drawer-head")).toMatch(/align-items:\s*flex-start/);
  expect(rule(".drawer-head")).toMatch(/justify-content:\s*space-between/);
  expect(rule(".drawer-head button.icon")).toMatch(/margin:\s*-9px -11px -9px 0/);
  expect(rule(".drawer-sub")).toMatch(/color:\s*var\(--muted\)/);
});

test("a form's footer is a row at the bottom of the drawer, right-aligned, kept in view, with a rule above it", () => {
  const foot = rule(".drawer-foot");
  expect(foot).toMatch(/position:\s*sticky/);
  // sticky measures from the body's content box, not its padding box: -24px puts the footer on the drawer's own edge (found by the shots, 24px short)
  expect(foot).toMatch(/bottom:\s*-24px/);
  expect(foot).toMatch(/justify-content:\s*flex-end/);
  expect(foot).toMatch(/border-top:\s*1px solid var\(--border\)/);
  expect(foot).toMatch(/background:\s*var\(--surface\)/);
  // the gutter is taken back at both sides and the body's own bottom padding at the foot, so it reaches the edges
  expect(foot).toMatch(/margin:\s*auto calc\(var\(--drawer-pad\) \* -1\) -24px/);
  // a form fills what is left, so that "auto" pushes the footer down
  expect(rule(".drawer-body > form.stack")).toMatch(/flex:\s*1/);
  expect(rule(".drawer-body > form.stack")).toMatch(/flex-direction:\s*column/);
  // the form is a .card, which scrolls sideways and so clips the footer's hang below it: its buttons lost their last 8px (found by the UXR-22 shots)
  expect(rule(".drawer-body > form.stack")).toMatch(/overflow:\s*visible/);
});

test("a variable's actions are one row with Delete pushed to the far end", () => {
  expect(rule(".detail-actions")).toMatch(/display:\s*flex/);
  expect(rule(".detail-actions")).toMatch(/align-items:\s*center/);
  expect(rule(".detail-actions button.danger")).toMatch(/margin-left:\s*auto/);
});

// VUI-7: the Create drawer: ticks that read as chips, Advanced options as a quiet disclosure, Generate beside the value
test("the environments to also create in are ticks that read as chips, wrap, and show a ticked one in the action colour", () => {
  const set = rule("fieldset.also");
  expect(set).toMatch(/display:\s*flex/);
  expect(set).toMatch(/flex-wrap:\s*wrap/);
  expect(set).toMatch(/border:\s*0/);
  const tick = rule(".also label");
  expect(tick).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  expect(tick).toMatch(/min-height:\s*\d+px/);
  expect(css).toMatch(/\.also label:has\(input:checked\)\s*{[^}]*border-color:\s*var\(--action\)/);
});

test("Advanced options is a disclosure whose heading is a whole-line target that shows it can be pressed", () => {
  const heading = rule("details.advanced > summary");
  expect(heading).toMatch(/cursor:\s*pointer/);
  expect(heading).toMatch(/min-height:\s*44px/);
  // any display but list-item hides the browser's arrow, and with it the only sign that the heading opens
  expect(heading).toMatch(/display:\s*list-item/);
});

test("a tick with its words is one line: the box beside the text, not above it", () => {
  const tick = rule("label.tick");
  expect(tick).toMatch(/display:\s*flex/);
  expect(tick).toMatch(/align-items:\s*center/);
});

test("the value box and its Generate button share a line, the box taking what the button leaves", () => {
  expect(rule(".with-action")).toMatch(/display:\s*flex/);
  // as wide as the other fields (an input stops at 30rem), so the button does not stick out past them
  expect(rule(".with-action")).toMatch(/max-width:\s*30rem/);
  // the input of a secret and the textarea of the other kinds are the same box
  expect(css).toMatch(
    /\.with-action input,\s*\.with-action textarea\s*{[^}]*flex:\s*1 1 0[^}]*min-width:\s*0/,
  );
});

// VUI-8: the environment menu: the button cuts a long choice short, the bar holds it above the cards, the dialog is centred
test("the environment button shows its choice on one line and cuts a long one short, so it never widens the page", () => {
  const shown = rule("button .shown");
  expect(shown).toMatch(/overflow:\s*hidden/);
  expect(shown).toMatch(/text-overflow:\s*ellipsis/);
  expect(shown).toMatch(/white-space:\s*nowrap/);
  expect(shown).toMatch(/max-width:\s*\d+(\.\d+)?rem/);
});

test("the menu's rows are whole-line targets, and its Add environment and hint sit below them", () => {
  expect(rule(".env-menu")).toMatch(/display:\s*grid/);
  expect(rule(".env-menu label.tick")).toMatch(/min-height:\s*44px/);
  expect(rule(".env-menu .hint")).toMatch(/color:\s*var\(--muted\)/);
});

test("the bar the environment menu sits in anchors its panel, so a phone's full-width panel is as wide as the page", () => {
  expect(rule(".env-bar")).toMatch(/position:\s*relative/);
});

test("a centred drawer is a box in the middle of the screen, no taller than it, with its own border all round", () => {
  const box = rule(".drawer.centered");
  expect(box).toMatch(/inset:\s*0/);
  expect(box).toMatch(/margin:\s*auto/);
  // not `auto`: with both edges at 0 an auto height fills the screen, and fit-content is what lets the auto margins centre it
  expect(box).toMatch(/(^|[\s;{])height:\s*fit-content/);
  expect(box).toMatch(/max-height:\s*calc\(100% - \d+px\)/);
  expect(box).toMatch(/width:\s*min\(\d+(\.\d+)?rem,\s*calc\(100% - \d+px\)\)/);
  expect(box).toMatch(/border:\s*1px solid var\(--line-strong\)/);
  expect(box).toMatch(/border-radius:\s*var\(--radius-field\)/);
});

// VUI-9: the matrix of marks and its open row
test("a mark is green where set, yellow where missing and red where it does not resolve, in the status tokens", () => {
  expect(rule(".cell-mark.set")).toMatch(/color:\s*var\(--ok\)/);
  expect(rule(".cell-mark.missing")).toMatch(/color:\s*var\(--warn\)/);
  expect(rule(".cell-mark.broken")).toMatch(/color:\s*var\(--danger\)/);
  expect(rule(".cell-mark")).toMatch(/display:\s*inline-flex/);
});

test("the key's arrow points right when its row is shut and down when it is open", () => {
  expect(rule(".chev")).toMatch(/rotate\(-90deg\)/);
  expect(rule('button[aria-expanded="true"] .chev')).toMatch(/transform:\s*none/);
});

// UXR-17: the Status row's link out and Jobs arrow are drawn at the small size beside their words
test("a row's link out and its arrow are inline with their words, at 16px", () => {
  expect(rule(".row.actions a")).toMatch(/display:\s*inline-flex/);
  expect(rule(".row.actions .ico")).toMatch(/width:\s*16px/);
  expect(rule(".row.actions .ico")).toMatch(/height:\s*16px/);
});

test("the open row is a list of lines, one for each environment, each a row that wraps on a narrow screen", () => {
  expect(rule("ul.env-rows")).toMatch(/list-style:\s*none/);
  expect(rule("tr.env-open > td")).toMatch(/height:\s*auto/);
  const line = rule(".env-line");
  expect(line).toMatch(/display:\s*flex/);
  expect(line).toMatch(/flex-wrap:\s*wrap/);
  expect(line).toMatch(/min-height:\s*44px/);
  expect(rule(".env-name")).toMatch(/flex:\s*0 0 7rem/);
});

test("a long value on a line is cut short with an ellipsis and never widens the page", () => {
  const value = rule("button.env-value");
  expect(value).toMatch(/min-width:\s*0/);
  expect(value).toMatch(/max-width:\s*100%/);
  const code = rule("button.env-value code");
  expect(code).toMatch(/overflow:\s*hidden/);
  expect(code).toMatch(/text-overflow:\s*ellipsis/);
  expect(code).toMatch(/white-space:\s*nowrap/);
});

// UXR-22 (moved from VUI-9): the open row's line buttons are always shown, as a table row's are
test("a line's buttons are always shown, pushed to the right of the line", () => {
  const actions = rule(".line-actions");
  expect(actions).not.toMatch(/opacity/);
  expect(actions).toMatch(/margin-left:\s*auto/);
  expect(css).not.toMatch(/\.line-actions\s*{[^}]*opacity:\s*0/);
  expect(css).not.toMatch(/\.env-line:hover \.line-actions|\.env-line:focus-within \.line-actions/);
  expect(rule(".line-actions button.icon")).toMatch(/width:\s*32px/);
});

// UXR-22: a cell of the matrix is a button with its picture and its words, the board's
test("a cell button of the matrix is a bordered pill of 36px at least, the picture and its words on one line", () => {
  const cell = rule("button.mx-cell");
  expect(cell).toMatch(/min-height:\s*36px/);
  expect(cell).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(cell).toMatch(/white-space:\s*nowrap/);
  // the mark keeps its status colour inside the button, and the words keep the text colour
  expect(rule(".cell-mark")).toMatch(/gap:\s*8px/);
});

test("alignment and hover (VUI-19): a row's buttons share a middle, a link, a logo and a summary all answer a pointer", () => {
  // an icon button and a text button side by side sat 5.8px apart on the baseline
  expect(rule(".row-actions button")).toMatch(/vertical-align:\s*middle/);
  // a badge in a line of words sat 3.8px high on the bottom of its picture (Sync, Drift)
  expect(rule(".st")).toMatch(/vertical-align:\s*middle/);
  // the mark and the name stay together, so a narrow name column wraps the tags and not the key under its own mark
  expect(rule(".key-name")).toMatch(/white-space:\s*nowrap/);
  expect(rule("a:hover")).toMatch(/text-decoration-thickness:\s*2px/);
  expect(rule("summary")).toMatch(/cursor:\s*pointer/);
  expect(rule("summary:hover")).toMatch(/color:\s*var\(--accent\)/);
  expect(rule(".brandrow:hover")).toMatch(/color:\s*var\(--accent\)/);
});

// VUI-17: the matrix scrolls inside its own box, and the first column (the variable names) stays in view with a
// background of its own, so what slides under it is not seen through it; the row pointed at changes it too.
test("the matrix keeps its first column in view while its box scrolls sideways", () => {
  expect(css).toMatch(/\.matrix,\s*\.scroll\s*{[^}]*overflow-x:\s*auto/);
  const first = rule(".matrix th:first-child");
  expect(first).toMatch(/position:\s*sticky/);
  expect(first).toMatch(/left:\s*0/);
  expect(first).toMatch(/background:\s*var\(--surface\)/);
  // UXR-6: the row's hover is half the tint, so the frozen name (opaque) takes the same colour mixed with the card
  expect(rule(".matrix tbody tr:hover th:first-child")).toMatch(
    /background:\s*color-mix\(in srgb, var\(--slate-tint\), var\(--surface\) 50%\)/,
  );
});

// UXR-1 (feature 32): the standard's tokens and its one motion rule. Motion answers a touch: colour and opacity
// fade, an entering thing may also move by a token, and reduced motion zeroes the tokens, so fades stay and
// movement goes.
test("the motion and shape tokens have the values the design settled", () => {
  expect(tokens(light)).toMatchObject({
    "--dur-1": "120ms",
    "--dur-2": "200ms",
    "--dur-3": "320ms",
    "--ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
    "--ease-in": "cubic-bezier(0.64, 0, 0.78, 0)",
    "--ease-io": "cubic-bezier(0.65, 0, 0.35, 1)",
    "--r-sm": "8px",
    "--r-md": "12px",
    "--r-lg": "20px",
  });
});

const csv = (list: string) => list.split(/,(?![^(]*\))/).map((part) => part.trim());
const SPINNERS = ["job-spin", "busy-spin"];
const FADES = ["opacity", "color", "background", "background-color", "border-color", "filter"];

test("a transition names only colours, opacity and filter; it never animates layout", () => {
  const declared = [...css.matchAll(/(?:^|[\s;{])transition(?:-property)?\s*:\s*([^;}]+)[;}]/g)];
  expect(declared.length).toBeGreaterThan(0);
  for (const [, list] of declared)
    for (const one of csv(list ?? "")) expect(FADES).toContain(one.split(/\s+/)[0] ?? "");
});

test("a keyframe sets only transform, opacity, colours and filter, and moves by a token", () => {
  const frames = [...css.matchAll(/@keyframes\s+([\w-]+)\s*{((?:[^{}]*{[^}]*})*)\s*}/g)];
  expect(frames.length).toBeGreaterThan(0);
  for (const [, name, body] of frames) {
    for (const [, inner] of (body ?? "").matchAll(/{([^}]*)}/g))
      for (const declaration of (inner ?? "").split(";")) {
        const [property = "", ...rest] = declaration.split(":");
        const text = rest.join(":");
        if (!property.trim()) continue;
        expect([...FADES, "transform", "animation-timing-function"]).toContain(property.trim());
        // the spinners (a running job's, a busy button's) turn and are switched off by being inside no-preference; every other move is a token
        if (property.trim() === "transform" && !SPINNERS.includes(name ?? ""))
          expect(text).toMatch(/var\(--(move|pop)-/);
      }
  }
});

test("reduced motion zeroes every distance and the pop scale, and leaves the durations alone", () => {
  const reduce =
    css.match(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{([^}]*)}\s*}/)?.[1] ?? "";
  const moves = names(light).filter((name) => /^--(move|pop)-/.test(name ?? ""));
  expect(moves.length).toBeGreaterThan(0);
  expect(names(reduce).sort()).toEqual([...moves].sort());
  for (const [name, zero] of Object.entries(tokens(reduce)))
    expect(zero).toBe(name.startsWith("--pop-") ? "1" : "0px");
  // one block, not a rule beside every animation
  expect(css.match(/prefers-reduced-motion:\s*reduce/g)?.length).toBe(1);
});

// UXR-29 (feature 32): the sweep over every animation in the sheet. One that runs once moves by the tokens the block above
// zeroes (the keyframe test holds its moves to them); one that loops exists only where motion is welcome.
test("every animation names a keyframe, and none loops outside prefers-reduced-motion: no-preference", () => {
  const welcome = /@media \(prefers-reduced-motion: no-preference\)\s*{(?:[^{}]*{[^}]*})*\s*}/g;
  const known = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  const declared = (text: string) =>
    [...text.matchAll(/(?:^|[\s;{])animation(?:-name)?\s*:\s*([^;}]+)[;}]/g)].map(
      (m) => m[1] ?? "",
    );
  const looped = css.match(welcome) ?? [];
  expect(looped.length).toBeGreaterThan(0);
  expect(declared(css).length).toBeGreaterThan(declared(looped.join("\n")).length);
  for (const one of declared(css)) expect(one.split(/\s+/).some((t) => known.has(t))).toBe(true);
  for (const one of declared(css.replace(welcome, ""))) expect(one).not.toMatch(/\binfinite\b/);
});

// UXR-7 (feature 32): overlays enter and nothing else. A keyframe has only a `from`, so the element ends where its own
// rules put it; nothing waits on a leave, and reduced motion keeps the fade because the tokens it zeroes are the moves.
const frames = (name: string) =>
  css.match(new RegExp(`@keyframes ${name}\\s*{\\s*from\\s*{([^}]*)}\\s*}`))?.[1] ?? "";

test("the drawer slides in from the right over a scrim that fades, both over --dur-3", () => {
  expect(rule("button.drawer-scrim")).toMatch(
    /animation:\s*fade-in var\(--dur-3\) var\(--ease-out\)/,
  );
  expect(rule(".drawer")).toMatch(/animation:\s*slide-in var\(--dur-3\) var\(--ease-out\)/);
  expect(frames("fade-in")).toMatch(/opacity:\s*0/);
  expect(frames("slide-in")).toMatch(/opacity:\s*0/);
  expect(frames("slide-in")).toMatch(/transform:\s*translateX\(var\(--move-drawer\)\)/);
});

test("a popover and a menu pop from their opener over --dur-2: a fade, a rise and a scale, each a token", () => {
  for (const selector of [".popover-panel", ".menu"])
    expect(rule(selector)).toMatch(/animation:\s*pop-in var\(--dur-2\) var\(--ease-out\)/);
  const from = frames("pop-in");
  expect(from).toMatch(/opacity:\s*0/);
  // --menu-dir is -1 on a menu that opens over its button (RowMenu), so either way it moves toward the button
  expect(from).toMatch(/translateY\(calc\(var\(--move-menu\) \* var\(--menu-dir, 1\)\)\)/);
  expect(from).toMatch(/scale\(var\(--pop-scale\)\)/);
  // the popover hangs from its button's lower left corner; a menu's own origin is set where it is placed (RowMenu)
  expect(rule(".popover-panel")).toMatch(/transform-origin:\s*top left/);
});

test("the centred drawer pops in the middle of the screen instead of sliding from the side", () => {
  expect(rule(".drawer.centered")).toMatch(/animation:\s*pop-in var\(--dur-2\) var\(--ease-out\)/);
});

test("an overlay is enter only: no leave keyframes, and no animation that holds or repeats", () => {
  expect(css).not.toMatch(/@keyframes [\w-]*-out\b/);
  for (const selector of [
    "button.drawer-scrim",
    ".drawer",
    ".drawer.centered",
    ".popover-panel",
    ".menu",
  ])
    expect(rule(selector).match(/animation:\s*([^;]+);/)?.[1] ?? "").not.toMatch(
      /\b(both|forwards|backwards|infinite|alternate)\b/,
    );
});

// found by the cut B guidelines review: what scrolls inside a modal does not hand its scroll on to the page behind it
test("the body of a drawer and of a dialog contains its overscroll", () => {
  for (const selector of [".drawer-body", ".dialog-body"])
    expect(rule(selector)).toMatch(/overscroll-behavior:\s*contain/);
});

// UXR-10 (feature 32): a page enters when the route changes, by a fade and a rise of --move-page over --dur-2, and only then.
test("a page enters over --dur-2 with a fade and a rise by --move-page, once, with nothing held after", () => {
  const enter = rule(".page-enter");
  expect(enter).toMatch(/animation:\s*page-in var\(--dur-2\) var\(--ease-out\)\s*;/);
  expect(enter).not.toMatch(/\b(both|forwards|backwards|infinite|alternate)\b/);
  expect(frames("page-in")).toMatch(/opacity:\s*0/);
  expect(frames("page-in")).toMatch(/transform:\s*translateY\(var\(--move-page\)\)/);
  // the distance is a token, and the one reduced-motion block (held to its full list above) zeroes it, so the fade stays
  expect(tokens(light)["--move-page"]).toBe("6px");
  expect(css).toMatch(/prefers-reduced-motion:\s*reduce\)\s*{\s*:root\s*{[^}]*--move-page:\s*0px/);
});

// UXR-9 (feature 32): a toast reports a result and leaves. It sits in the bottom corner (the middle on a phone), under every
// overlay so it can never cover a dialog's buttons, and it rises on the way in by a token that reduced motion zeroes.
test("the toasts sit under the menus and the scrim, in the bottom right corner and the bottom middle on a phone", () => {
  const z = (r: string) => Number(r.match(/z-index:\s*(\d+)/)?.[1]);
  const toasts = rule(".toasts");
  expect(toasts).toMatch(/position:\s*fixed/);
  expect(toasts).toMatch(/right:\s*24px/);
  expect(toasts).toMatch(/bottom:\s*24px/);
  expect(z(toasts)).toBeGreaterThan(0);
  expect(z(toasts)).toBeLessThan(z(rule(".menu")));
  expect(z(toasts)).toBeLessThan(z(rule(".drawer-layer")));
  expect(css).toMatch(
    /@media \(max-width: 600px\) \{[^@]*\.toasts \{\s*right:\s*16px;\s*bottom:\s*16px;\s*left:\s*16px;\s*width:\s*fit-content;\s*margin-inline:\s*auto/,
  );
});

test("a toast is a bordered box on the surface that rises over --dur-2, enters once, and paints no box when there is none", () => {
  const on = rule(".toasts.on");
  expect(on).toMatch(/background:\s*var\(--surface\)/);
  expect(on).toMatch(/color:\s*var\(--text\)/);
  expect(on).toMatch(/border:\s*1px solid var\(--line-strong\)/);
  expect(on).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(on).toMatch(/min-height:\s*52px/);
  expect(on).toMatch(/animation:\s*rise-in var\(--dur-2\) var\(--ease-out\)\s*;/);
  expect(frames("rise-in")).toMatch(/opacity:\s*0/);
  expect(frames("rise-in")).toMatch(/transform:\s*translateY\(var\(--move-toast\)\)/);
  // the live region is there before the words, so the box belongs to the state and not to the element
  expect(rule(".toasts")).not.toMatch(/border|background|padding/);
  // its glyph is the ok colour on the surface, which the pair test above holds to 4.5:1
  expect(rule(".toasts.on .ico")).toMatch(/color:\s*var\(--ok\)/);
});

// UXR-8 (feature 32): the dialog is one question with two answers. A box in the middle of the screen that pops; under
// 600px a sheet on the bottom edge that rises over --dur-3, its two buttons sharing the width.
test("a dialog is a 28rem box in the middle of the screen with the large corner, and it pops", () => {
  const box = rule(".dialog");
  expect(box).toMatch(/position:\s*fixed/);
  expect(box).toMatch(/inset:\s*0/);
  expect(box).toMatch(/margin:\s*auto/);
  expect(box).toMatch(/width:\s*min\(28rem,\s*calc\(100% - 32px\)\)/);
  expect(box).toMatch(/height:\s*fit-content/);
  expect(box).toMatch(/border:\s*1px solid var\(--line-strong\)/);
  expect(box).toMatch(/border-radius:\s*var\(--r-lg\)/);
  expect(box).toMatch(/animation:\s*pop-in var\(--dur-2\) var\(--ease-out\)/);
  // a long form scrolls inside the box, and the buttons stay in it
  expect(box).toMatch(/max-height:\s*calc\(100% - 32px\)/);
  expect(rule(".dialog-body")).toMatch(/overflow-y:\s*auto/);
  expect(rule(".dialog-body > p")).toMatch(/margin:\s*0/);
  expect(rule(".dialog-foot")).toMatch(/justify-content:\s*flex-end/);
});

test("under 600px a dialog is a sheet on the bottom edge that rises over --dur-3, and its buttons share the width", () => {
  const sheet = css.match(
    /@media \(max-width: 600px\)\s*{\s*\.dialog\s*{([^}]*)}\s*\.dialog-foot\s*{([^}]*)}/,
  );
  expect(sheet).toBeTruthy();
  expect(sheet?.[1]).toMatch(/inset:\s*auto 0 0/);
  expect(sheet?.[1]).toMatch(/margin:\s*0/);
  expect(sheet?.[1]).toMatch(/width:\s*100%/);
  expect(sheet?.[1]).toMatch(/border-radius:\s*var\(--r-lg\) var\(--r-lg\) 0 0/);
  expect(sheet?.[1]).toMatch(/animation:\s*slide-up var\(--dur-3\) var\(--ease-out\)/);
  expect(sheet?.[2]).toMatch(/grid-template-columns:\s*1fr 1fr/);
  // it rises by a token that reduced motion zeroes, so the fade stays and the movement goes (the board slides 100%)
  expect(frames("slide-up")).toMatch(/opacity:\s*0/);
  expect(frames("slide-up")).toMatch(/transform:\s*translateY\(var\(--move-drawer\)\)/);
});

test("a dialog's animations enter and stop: nothing holds, repeats or alternates", () => {
  expect(rule(".dialog").match(/animation:\s*([^;]+);/)?.[1] ?? "").not.toMatch(
    /\b(both|forwards|backwards|infinite|alternate)\b/,
  );
});

// UXR-2 (feature 32): buttons to the Buttons board. A slate tile with the medium corner; hover and pressed mix the text
// colour in; primary and solid danger brighten and dim by filter; a press settles by a token; busy draws a spinner
// before the label.
const BUTTON = "button,\n.button";
const HOVER = "button:hover:not(:disabled),\n.button:hover";
const PRESSED = "button:active:not(:disabled),\n.button:active";

test("a button is a 44px slate tile with the medium corner and a transparent border", () => {
  const base = rule(BUTTON);
  expect(base).toMatch(/min-height:\s*44px/);
  expect(base).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(base).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(base).toMatch(/border:\s*1\.5px solid transparent/);
  expect(base).toMatch(/font-weight:\s*700/);
});

test("hover and pressed mix the text colour into the tile, and a press settles by a token, never a scale", () => {
  expect(rule(HOVER)).toMatch(/color-mix\(in srgb, var\(--slate-tint\), var\(--text\) 9%\)/);
  const pressed = rule(PRESSED);
  expect(pressed).toMatch(/color-mix\(in srgb, var\(--slate-tint\), var\(--text\) 15%\)/);
  expect(pressed).toMatch(/transform:\s*translateY\(var\(--move-press\)\)/);
  for (const [, selector, body] of css.matchAll(/([^{}]*:active[^{}]*){([^}]*)}/g))
    if (/button/.test(selector ?? "")) expect(body).not.toMatch(/scale\(/);
});

test("primary is the action colour and brightens on hover and dims when pressed", () => {
  const primary = rule("button.primary,\n.button.primary");
  expect(primary).toMatch(/background:\s*var\(--action\)/);
  expect(primary).toMatch(/color:\s*var\(--on-action\)/);
  const hover = rule("button.primary:hover:not(:disabled),\n.button.primary:hover");
  expect(hover).toMatch(/background:\s*var\(--action\)/);
  expect(hover).toMatch(/filter:\s*brightness\(1\.14\)/);
  expect(rule("button.primary:active:not(:disabled),\n.button.primary:active")).toMatch(
    /filter:\s*brightness\(0\.9\)/,
  );
});

test("danger is tinted, and the solid one (the confirm of a delete) is the danger colour", () => {
  const danger = rule("button.danger");
  expect(danger).toMatch(/background:\s*var\(--danger-tint\)/);
  expect(danger).toMatch(/color:\s*var\(--danger\)/);
  // hovered and pressed are one rule: the board's deeper pressed mix reads under 4.5:1 (see the contrast test)
  expect(rule("button.danger:hover:not(:disabled),\nbutton.danger:active:not(:disabled)")).toMatch(
    /color-mix\(in srgb, var\(--danger-tint\), var\(--danger\) 14%\)/,
  );
  const solid = rule("button.danger.solid");
  expect(solid).toMatch(/background:\s*var\(--danger\)/);
  expect(solid).toMatch(/color:\s*var\(--accent-text\)/);
  expect(rule("button.danger.solid:hover:not(:disabled)")).toMatch(/filter:\s*brightness\(1\.1\)/);
  expect(rule("button.danger.solid:active:not(:disabled)")).toMatch(
    /filter:\s*brightness\(0\.88\)/,
  );
});

test("quiet shows a tile only when pointed at; a quiet Delete shows the danger tint", () => {
  expect(rule("button.quiet:hover:not(:disabled)")).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(
    rule("button.quiet.danger:hover:not(:disabled),\nbutton.quiet.danger:active:not(:disabled)"),
  ).toMatch(/background:\s*var\(--danger-tint\)/);
});

test("a small button is 32px wide as an icon, and an icon button is 44px, as tall as any button", () => {
  expect(rule("button.icon")).toMatch(/width:\s*44px/);
  expect(rule("button.icon.small")).toMatch(/width:\s*32px/);
});

test("disabled fades and shows it cannot be pressed; busy ignores the pointer and draws a spinner before the label", () => {
  const disabled = rule("button:disabled");
  expect(disabled).toMatch(/opacity:\s*0\.5/);
  expect(disabled).toMatch(/cursor:\s*not-allowed/);
  // a button that is busy and disabled (the pages disable it so a key cannot press it again) looks busy, not faded
  const busyDisabled = rule('button[aria-busy="true"]:disabled');
  expect(busyDisabled).toMatch(/opacity:\s*1\b/);
  expect(busyDisabled).toMatch(/cursor:\s*progress/);
  const busy = rule('button[aria-busy="true"],\n.button[aria-busy="true"]');
  expect(busy).toMatch(/pointer-events:\s*none/);
  const spinner = rule('button[aria-busy="true"]::before,\n.button[aria-busy="true"]::before');
  expect(spinner).toMatch(/content:\s*""/);
  expect(spinner).toMatch(/border:\s*2px solid currentColor/);
  expect(spinner).toMatch(/border-right-color:\s*transparent/);
  // it turns only where motion is welcome (it reuses the running job's keyframes); reduced, it is a still ring
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: no-preference\)\s*{\s*button\[aria-busy="true"\]::before,\s*\.button\[aria-busy="true"\]::before\s*{[^}]*animation:\s*busy-spin/,
  );
});

test("a menu item and a segment are not slate tiles: the container is the surface they sit on", () => {
  // found by the cut A review: both rules only reset the edge, so they took the base tile of UXR-2
  expect(rule(".menu button")).toMatch(/background:\s*transparent/);
  expect(rule(".seg button")).toMatch(/background:\s*transparent/);
  // the pressed segment is raised on the surface (UXR-11 pins it below)
  expect(rule('.seg button[aria-pressed="true"]')).toMatch(/background:\s*var\(--surface\)/);
});

test("a button keeps the page's focus ring, and nothing switches it off", () => {
  expect(rule(":focus-visible")).toMatch(/outline:\s*3px solid var\(--focus\)/);
  expect(css).not.toMatch(/(?:button|\.button)[^{}]*:focus[^{}]*{[^}]*outline:\s*(?:none|0)\b/);
});

/** The colour of `color-mix(in srgb, from, to N%)` for two #rrggbb colours, as the browser would mix it. */
function mixed(from: string, to: string, percent: number) {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(from, i) * (1 - percent / 100) + channel(to, i) * (percent / 100))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// the board mixes 24% danger into the tint when pressed (3.89:1 light, 4.05:1 dark, under the 4.5:1 this file holds every
// pair to), so a danger tile uses one mix for hover and press and the press shows by its settle; every mix in the sheet is read
test("every label reads on its tile in both sets (4.5:1), hovered and pressed too", () => {
  const percents = [
    ...css.matchAll(/color-mix\(in srgb, var\(--danger-tint\), var\(--danger\) (\d+)%\)/g),
  ].map((m) => Number(m[1]));
  expect(percents.length).toBeGreaterThan(0);
  for (const set of [light, dark]) {
    const [t, slate, danger, tint, accent] = [
      "--text",
      "--slate-tint",
      "--danger",
      "--danger-tint",
      "--accent-text",
    ].map((name) => value(set, name) || value(light, name)) as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(contrast(t, slate)).toBeGreaterThanOrEqual(4.5);
    for (const percent of [9, 15])
      expect(contrast(t, mixed(slate, t, percent))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(danger, tint)).toBeGreaterThanOrEqual(4.5);
    for (const percent of percents)
      expect(contrast(danger, mixed(tint, danger, percent))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, danger)).toBeGreaterThanOrEqual(4.5);
  }
});

// UXR-29 (feature 32): primary's hover and press are a filter, which brightens the label with its tile, so the pair is read
// after the filter and not at rest only
const brightened = (hex: string, by: number) =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.min(255, Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * by))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

test("primary reads on its tile in both sets (4.5:1) at rest, hovered and pressed", () => {
  const by = (selector: string) =>
    Number(rule(selector).match(/brightness\(([\d.]+)\)/)?.[1] ?? Number.NaN);
  const hover = by("button.primary:hover:not(:disabled),\n.button.primary:hover");
  const press = by("button.primary:active:not(:disabled),\n.button.primary:active");
  expect(hover).toBeGreaterThan(1);
  expect(press).toBeLessThan(1);
  for (const set of [light, dark]) {
    const [action, on] = ["--action", "--on-action"].map(
      (name) => value(set, name) || value(light, name),
    ) as [string, string];
    for (const f of [1, hover, press])
      expect(contrast(brightened(on, f), brightened(action, f))).toBeGreaterThanOrEqual(4.5);
  }
});

// UXR-3 (feature 32): fields and checks to the Forms board. One anatomy: the label above, the control, then a hint or an
// error. A field is 44px with the medium corner and a one-pixel edge that is dark at rest, darker pointed at, the focus
// colour in use and the danger colour when invalid (aria-invalid); a check or radio is a drawn 20px box in a 44px label.
const FIELDS = ["input", "select", "textarea"];
const each = (suffix: string) => FIELDS.map((tag) => `${tag}${suffix}`).join(",\n");

test("a field is 44px with the medium corner, a one-pixel edge and the page's type", () => {
  const field = rule(each(""));
  expect(field).toMatch(/min-height:\s*44px/);
  expect(field).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(field).toMatch(/border:\s*1px solid var\(--field-line\)/);
  expect(field).toMatch(/font:\s*inherit/);
  expect(rule("textarea")).toMatch(/min-height:\s*\d+(\.\d+)?rem/);
});

test("a label sits 6px above its control, in weight 600", () => {
  const label = rule("label,\n.field");
  expect(label).toMatch(/gap:\s*6px/);
  expect(label).toMatch(/font-weight:\s*600/);
});

test("a field's edge goes darker when pointed at, to the focus colour in use, and to the danger colour when invalid", () => {
  expect(rule(each(":hover:not(:disabled)"))).toMatch(/border-color:\s*var\(--muted\)/);
  const focus = rule(each(":focus-visible:not(:disabled)"));
  const invalid = rule(each('[aria-invalid="true"]:not(:disabled)'));
  expect(focus).toMatch(/border-color:\s*var\(--focus\)/);
  expect(invalid).toMatch(/border-color:\s*var\(--danger\)/);
  // the later rule wins at equal strength: an invalid field keeps its danger edge when it is hovered or focused (the ring still shows)
  const at = (text: string) => css.indexOf(text);
  expect(at(each(":hover:not(:disabled)"))).toBeLessThan(at(each(":focus-visible:not(:disabled)")));
  expect(at(each(":focus-visible:not(:disabled)"))).toBeLessThan(
    at(each('[aria-invalid="true"]:not(:disabled)')),
  );
});

test("a placeholder is an example in the muted colour, and a disabled field is a slate box with muted words", () => {
  expect(rule("::placeholder")).toMatch(/color:\s*var\(--muted\)/);
  const disabled = rule(each(":disabled"));
  expect(disabled).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(disabled).toMatch(/color:\s*var\(--muted\)/);
  expect(disabled).toMatch(/cursor:\s*not-allowed/);
});

test("a check and a radio are drawn 20px boxes, filled with the action colour when on", () => {
  const box = rule('input[type="checkbox"],\ninput[type="radio"]');
  expect(box).toMatch(/appearance:\s*none/);
  expect(box).toMatch(/width:\s*20px/);
  expect(box).toMatch(/height:\s*20px/);
  expect(box).toMatch(/border:\s*1\.5px solid var\(--field-line\)/);
  expect(box).not.toMatch(/accent-color/);
  expect(rule('input[type="checkbox"]')).toMatch(/border-radius:\s*6px/);
  expect(rule('input[type="radio"]')).toMatch(/border-radius:\s*50%/);
  // on, and the select-all box that is part-way, are filled the same
  const on = rule(
    'input[type="checkbox"]:checked,\ninput[type="radio"]:checked,\ninput[type="checkbox"]:indeterminate',
  );
  expect(on).toMatch(/background:\s*var\(--action\)/);
  expect(on).toMatch(/border-color:\s*var\(--action\)/);
  // the mark is drawn in the colour made for the action colour; an unchecked box has none
  const tick = rule('input[type="checkbox"]::after');
  expect(tick).toMatch(/border-left:\s*2px solid var\(--on-action\)/);
  expect(tick).toMatch(/opacity:\s*0/);
  expect(rule('input[type="radio"]::after')).toMatch(/background:\s*var\(--on-action\)/);
  // the select-all box that is part-way is a dash, not an empty box
  const dash = rule('input[type="checkbox"]:indeterminate::after');
  expect(dash).toMatch(/background:\s*var\(--on-action\)/);
});

test("a mark pops in by a keyframe that moves by the pop token, so reduced motion makes it a fade", () => {
  const marks = rule('input[type="checkbox"]:checked::after,\ninput[type="radio"]:checked::after');
  expect(marks).toMatch(/opacity:\s*1/);
  expect(marks).toMatch(/animation:\s*mark-in var\(--dur-2\) var\(--ease-out\)/);
  expect(css).toMatch(/@keyframes mark-in\s*{[^}]*{[^}]*scale\(var\(--pop-scale\)\)/);
});

test("a choice is a whole-line target: a tick label is 44px and the pointer shows it can be pressed", () => {
  const tick = rule("label.tick");
  expect(tick).toMatch(/min-height:\s*44px/);
  expect(tick).toMatch(/cursor:\s*pointer/);
});

test("a disabled check or radio shows it cannot be pressed (the drawn box's pointer must not win over the disabled field's)", () => {
  expect(rule('input[type="checkbox"]:disabled,\ninput[type="radio"]:disabled')).toMatch(
    /cursor:\s*not-allowed/,
  );
});

test("a hint is small and muted, and a field's error is small, bold and danger, with room for its glyph", () => {
  const hint = rule(".hint");
  expect(hint).toMatch(/font-size:\s*12\.5px/);
  expect(hint).toMatch(/color:\s*var\(--muted\)/);
  const error = rule(".field > .error");
  expect(error).toMatch(/display:\s*flex/);
  expect(error).toMatch(/gap:\s*6px/);
  expect(error).toMatch(/font-size:\s*12\.5px/);
  expect(error).toMatch(/font-weight:\s*600/);
});

test("every edge and every word of a field reads in light, dark and forced dark (3:1 for an edge, 4.5:1 for words)", () => {
  for (const set of [light, dark, forced]) {
    const [surface, edge, muted, danger, focus, slate, action, on] = [
      "--surface",
      "--field-line",
      "--muted",
      "--danger",
      "--focus",
      "--slate-tint",
      "--action",
      "--on-action",
    ].map((name) => value(set, name) || value(light, name)) as string[] as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    for (const colour of [edge, danger, focus, action])
      expect(contrast(colour, surface)).toBeGreaterThanOrEqual(3);
    // hint, placeholder and a disabled field's words
    expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, slate)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(danger, surface)).toBeGreaterThanOrEqual(4.5);
    // the tick on the box it is drawn on
    expect(contrast(on, action)).toBeGreaterThanOrEqual(4.5);
  }
});

// UXR-4 (feature 32): cards, figures, badges and tags to the Data board. A card is a flat box (no shadow) with the large
// corner and a 24px inset; a badge is a tinted pill with a shape and its words; a tag is a small mono label.
test("a card is a flat box with the large corner, a 24px inset and 16px between its parts", () => {
  const card = rule(".card");
  expect(card).toMatch(/border:\s*1px solid var\(--border\)/);
  expect(card).toMatch(/border-radius:\s*var\(--r-lg\)/);
  expect(card).not.toMatch(/box-shadow/);
  expect(card).toMatch(/padding:\s*24px/);
  expect(rule(".card-flow")).toMatch(/gap:\s*16px/);
  expect(rule(".card-head")).toMatch(/gap:\s*16px/);
  expect(rule(".card-sub")).toMatch(/color:\s*var\(--muted\)/);
});

test("cards side by side are one grid class 24px apart, and a figure tile has the card's corner and inset", () => {
  const grid = rule(".card-grid");
  expect(grid).toMatch(/display:\s*grid/);
  expect(grid).toMatch(/gap:\s*24px/);
  // as many to a line as fit, never wider than the screen
  expect(grid).toMatch(
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(\d+(\.\d+)?rem,\s*100%\),\s*1fr\)\)/,
  );
  const kpi = rule(".kpi");
  expect(kpi).toMatch(/border:\s*1px solid var\(--border\)/);
  expect(kpi).toMatch(/border-radius:\s*var\(--r-lg\)/);
  expect(kpi).toMatch(/padding:\s*20px 24px/);
  expect(rule(".kpi-value")).toMatch(/font-size:\s*32px/);
  expect(rule(".kpi-value")).toMatch(/line-height:\s*38px/);
  expect(rule(".kpi-foot")).toMatch(/font-size:\s*12\.5px/);
  expect(rule(".kpi-foot")).toMatch(/color:\s*var\(--muted\)/);
});

// each tone: the pill's tint, then the colour of its words (a fill, a word colour)
const BADGE = {
  ok: ["--mint", "--ok"],
  bad: ["--danger-tint", "--danger"],
  warn: ["--sun-tint", "--warn"],
  active: ["--aqua-tint", "--active"],
  manual: ["--slate-tint", "--text"],
} as const;

test("a badge is a 26px pill with a 14px shape and its words, tinted by its tone; quiet has no tint", () => {
  const st = rule(".st");
  expect(st).toMatch(/height:\s*26px/);
  expect(st).toMatch(/padding:\s*0 10px 0 8px/);
  expect(st).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  expect(st).toMatch(/font-size:\s*12\.5px/);
  expect(st).toMatch(/font-weight:\s*600/);
  expect(st).toMatch(/white-space:\s*nowrap/);
  // the vertical-align pin of VUI-19 stays: a badge in a line of words sits on its middle
  expect(st).toMatch(/vertical-align:\s*middle/);
  expect(rule(".st .glyph")).toMatch(/width:\s*14px/);
  expect(rule(".st .glyph")).toMatch(/height:\s*14px/);
  for (const [tone, [fill, word]] of Object.entries(BADGE)) {
    const r = rule(`.st-${tone}`);
    expect(r).toMatch(new RegExp(`background:\\s*var\\(${fill}\\)`));
    expect(r).toMatch(new RegExp(`color:\\s*var\\(${word}\\)`));
  }
  const quiet = rule(".st-quiet");
  expect(quiet).toMatch(/background:\s*transparent/);
  expect(quiet).toMatch(/color:\s*var\(--muted\)/);
  expect(quiet).toMatch(/padding-left:\s*0/);
});

test("a job node keeps its own look: the badge in it is the mark and a word under it, not a pill", () => {
  const node = rule(".job-flow .st");
  expect(node).toMatch(/height:\s*auto/);
  expect(node).toMatch(/padding:\s*0/);
  expect(node).toMatch(/background:\s*transparent/);
  expect(node).toMatch(/color:\s*var\(--text\)/);
  expect(node).toMatch(/white-space:\s*normal/);
});

test("a tag is a small mono label, cut short rather than wider than its box", () => {
  const tag = rule(".tag");
  expect(tag).toMatch(/height:\s*22px/);
  expect(tag).toMatch(/padding:\s*0 8px/);
  expect(tag).toMatch(/border-radius:\s*6px/);
  expect(tag).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(tag).toMatch(/color:\s*var\(--text\)/);
  expect(tag).toMatch(/font:\s*500 12px var\(--mono\)/);
  expect(tag).toMatch(/max-width:\s*100%/);
  expect(tag).toMatch(/text-overflow:\s*ellipsis/);
});

test("every badge tone reads in light, dark and forced dark: its words 4.5:1 on its tint, its shape 3:1", () => {
  const glyph = {
    ok: "--ok",
    bad: "--danger",
    warn: "--warn",
    active: "--active",
    manual: "--warn",
  };
  for (const set of [light, dark, forced]) {
    const v = (name: string) => value(set, name) || value(light, name);
    for (const [tone, [fill, word]] of Object.entries(BADGE)) {
      expect(contrast(v(word), v(fill))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v(glyph[tone as keyof typeof glyph]), v(fill))).toBeGreaterThanOrEqual(3);
    }
    // quiet has no tint: its words sit on the card, or on a row that is pointed at
    for (const under of ["--surface", "--slate-tint"]) {
      expect(contrast(v("--muted"), v(under))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v("--idle"), v(under))).toBeGreaterThanOrEqual(3);
    }
    // a tag's words on its tile
    expect(contrast(v("--text"), v("--slate-tint"))).toBeGreaterThanOrEqual(4.5);
  }
});

// UXR-5 (feature 32): a callout, an empty state and a skeleton line, to the Data board.
const CALLOUT = {
  info: ["--aqua-tint", "--active"],
  ok: ["--mint", "--ok"],
  warn: ["--sun-tint", "--warn"],
  bad: ["--danger-tint", "--danger"],
} as const;

test("a callout is a tinted box of the medium corner with its glyph beside its words, in one of four tones", () => {
  const box = rule(".callout");
  expect(box).toMatch(/display:\s*flex/);
  expect(box).toMatch(/align-items:\s*flex-start/);
  expect(box).toMatch(/gap:\s*12px/);
  expect(box).toMatch(/padding:\s*12px 16px/);
  expect(box).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(rule(".callout b")).toMatch(/font-weight:\s*700/);
  for (const [tone, [fill, glyph]] of Object.entries(CALLOUT)) {
    expect(rule(`.callout-${tone}`)).toMatch(new RegExp(`background:\\s*var\\(${fill}\\)`));
    expect(rule(`.callout-${tone} .ico`)).toMatch(new RegExp(`color:\\s*var\\(${glyph}\\)`));
  }
});

test("an empty state is centred with room around it: a round slate orb, a title, words capped in width; a failed one has a danger orb", () => {
  const empty = rule(".empty");
  expect(empty).toMatch(/display:\s*grid/);
  expect(empty).toMatch(/justify-items:\s*center/);
  expect(empty).toMatch(/gap:\s*8px/);
  expect(empty).toMatch(/padding:\s*48px 24px/);
  expect(empty).toMatch(/text-align:\s*center/);
  const orb = rule(".empty .orb");
  expect(orb).toMatch(/width:\s*56px/);
  expect(orb).toMatch(/height:\s*56px/);
  expect(orb).toMatch(/border-radius:\s*50%/);
  expect(orb).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(orb).toMatch(/color:\s*var\(--muted\)/);
  expect(rule(".empty p")).toMatch(/max-width:\s*44ch/);
  expect(rule(".empty p")).toMatch(/color:\s*var\(--muted\)/);
  const bad = rule(".empty-bad .orb");
  expect(bad).toMatch(/background:\s*var\(--danger-tint\)/);
  expect(bad).toMatch(/color:\s*var\(--danger\)/);
});

test("a skeleton line is a slate bar, and it pulses only where motion is welcome", () => {
  const skel = rule(".skel");
  expect(skel).toMatch(/display:\s*block/);
  expect(skel).toMatch(/height:\s*14px/);
  expect(skel).toMatch(/border-radius:\s*6px/);
  expect(skel).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(rule(".loading")).toMatch(/display:\s*grid/);
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: no-preference\)\s*{\s*\.skel\s*{[^}]*animation:\s*skel-pulse 1\.4s/,
  );
  // outside that block the bar is still: a pulse is a loop, and reduced motion keeps no loop
  expect(
    css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*{\s*\.skel\s*{[^}]*}\s*}/, ""),
  ).not.toMatch(/animation:\s*skel-pulse/);
  expect(css).toMatch(/@keyframes skel-pulse/);
});

test("every callout tone reads in light, dark and forced dark: words and a link 4.5:1 on the tint, the glyph 3:1, the empty orb's glyph 3:1", () => {
  for (const set of [light, dark, forced]) {
    const v = (name: string) => value(set, name) || value(light, name);
    for (const [fill, glyph] of Object.values(CALLOUT)) {
      expect(contrast(v("--text"), v(fill))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v("--accent"), v(fill))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v(glyph), v(fill))).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(v("--muted"), v("--slate-tint"))).toBeGreaterThanOrEqual(3);
    expect(contrast(v("--danger"), v("--danger-tint"))).toBeGreaterThanOrEqual(3);
  }
});

// UXR-6 (feature 32): the Data board's table. The card's inset stays the table's edge (the first and last cell have no
// padding of their own), so the board's tinted header band is left out: it would start at the first word.
test("a table's header is quiet: 12.5px, semi-bold, muted, in the words it is written", () => {
  const head = rule("th");
  expect(head).toMatch(/font-size:\s*12\.5px/);
  expect(head).toMatch(/font-weight:\s*600/);
  expect(head).toMatch(/color:\s*var\(--muted\)/);
  expect(head).toMatch(/padding:\s*12px 16px/);
  expect(head).toMatch(/white-space:\s*nowrap/);
  expect(head).not.toMatch(/text-transform/);
  expect(head).not.toMatch(/letter-spacing/);
});

test("a cell has 14px above and below its words with a hairline under it, and a row header is its name in semi-bold", () => {
  expect(css.match(/\nth,\s*td\s*{([^}]*)}/)?.[1]).toMatch(
    /border-bottom:\s*1px solid var\(--border\)/,
  );
  const name = rule("tbody th");
  expect(name).toMatch(/padding:\s*14px 16px/);
  expect(name).toMatch(/font-weight:\s*600/);
});

test("a row under the pointer takes half the slate tint, fading in over the short duration", () => {
  expect(rule("tbody tr:hover")).toMatch(
    /background:\s*color-mix\(in srgb, var\(--slate-tint\), transparent 50%\)/,
  );
  expect(rule("button,\n.button,\n.nav-item,\ntbody tr")).toMatch(
    /background-color var\(--dur-1\) var\(--ease-out\)/,
  );
});

test("a numeric column is right-aligned, its header with it", () => {
  expect(rule("th.num,\ntd.num")).toMatch(/text-align:\s*right/);
});

test("only the matrix freezes a column: no other table row header or cell is sticky", () => {
  const frozen = css.match(/[^{}]*\b(?:th|td)\b[^{}]*{[^}]*position:\s*sticky/g) ?? [];
  expect(frozen).toHaveLength(1);
  expect(frozen[0]).toMatch(/\.matrix th:first-child/);
});

test("row actions sit close: a quiet action in a cell keeps the small button's padding, and the actions are 4px apart", () => {
  expect(rule("td button.quiet")).toMatch(/padding:\s*0 12px/);
  expect(rule(".row.actions")).toMatch(/gap:\s*4px/);
});

test("words and muted words read on the row under the pointer in light, dark and forced dark (4.5:1)", () => {
  for (const set of [light, dark, forced]) {
    const v = (name: string) => value(set, name) || value(light, name);
    const hover = mixed(v("--slate-tint"), v("--surface"), 50);
    expect(contrast(v("--text"), hover)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--muted"), hover)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--accent"), hover)).toBeGreaterThanOrEqual(4.5);
  }
});

// UXR-11 (feature 32): the shell to the boards. The sidebar is 264 px, a nav item tints under the pointer and when it is
// the current page, the user and Sign out share a line, the theme toggle is a tray with the chosen side raised.
test("the sidebar is 264 px wide with the board's padding, and a rule sits above the user", () => {
  // 16.5rem is 264 px at the browser's size and grows with a larger one
  expect(rule(".app")).toMatch(/grid-template-columns:\s*16\.5rem minmax\(0, 1fr\)/);
  expect(rule(".side")).toMatch(/padding:\s*16px 12px/);
  expect(rule(".side-foot")).toMatch(/display:\s*flex/);
  expect(rule(".side-foot")).toMatch(/border-top:\s*1px solid var\(--border\)/);
});

test("the brand mark is the accent, and the organization switcher is a bordered tile that tints under the pointer", () => {
  expect(rule(".mark")).toMatch(/stroke:\s*var\(--accent\)/);
  expect(rule(".mark .dot")).toMatch(/fill:\s*var\(--accent\)/);
  expect(rule(".org")).toMatch(/border:\s*1px solid var\(--border\)/);
  expect(rule(".org")).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(rule(".org:hover")).toMatch(/background:\s*var\(--slate-tint\)/);
});

test("a nav item tints under the pointer and when it is the current page, which also reads heavier and takes the accent on its mark", () => {
  expect(rule(".nav-item")).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(rule(".nav-item:hover")).toMatch(/background:\s*var\(--slate-tint\)/);
  const current = rule('.nav-item[aria-current="page"]');
  expect(current).toMatch(/background:\s*var\(--slate-tint\)/);
  // the tint alone is the pointer's too, so the current page has a second sign that is not a colour
  expect(current).toMatch(/font-weight:\s*700/);
  expect(rule(".nav-item .ico")).toMatch(/color:\s*var\(--muted\)/);
  expect(rule(".nav-item:hover .ico")).toMatch(/color:\s*var\(--text\)/);
  expect(rule('.nav-item[aria-current="page"] .ico')).toMatch(/color:\s*var\(--accent\)/);
  expect(rule(".nav-item .ico")).toMatch(/transition:\s*color var\(--dur-1\) var\(--ease-out\)/);
});

test("the current nav item's words and mark, and the group headings, read in light, dark and forced dark", () => {
  for (const set of [light, dark, forced]) {
    const v = (name: string) => value(set, name) || value(light, name);
    const tint = v("--slate-tint");
    expect(contrast(v("--text"), tint)).toBeGreaterThanOrEqual(4.5);
    // the mark is a graphic: 3:1
    expect(contrast(v("--accent"), tint)).toBeGreaterThanOrEqual(3);
    expect(contrast(v("--muted"), v("--surface"))).toBeGreaterThanOrEqual(4.5);
  }
});

test("the theme toggle is a tray, and the chosen side is raised on the surface with an edge you can see", () => {
  expect(rule(".seg")).toMatch(/background:\s*var\(--slate-tint\)/);
  const chosen = rule('.seg button[aria-pressed="true"]');
  expect(chosen).toMatch(/background:\s*var\(--surface\)/);
  expect(chosen).toMatch(/color:\s*var\(--text\)/);
  // the board's edge is the faint --border; the chosen side must read without colour, so it takes the field edge (3:1)
  expect(chosen).toMatch(/border-color:\s*var\(--field-line\)/);
  expect(rule(".seg button")).toMatch(/color:\s*var\(--muted\)/);
  for (const set of [light, dark, forced]) {
    const v = (name: string) => value(set, name) || value(light, name);
    expect(contrast(v("--text"), v("--surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--field-line"), v("--surface"))).toBeGreaterThanOrEqual(3);
    expect(contrast(v("--muted"), v("--slate-tint"))).toBeGreaterThanOrEqual(4.5);
  }
});

// UXR-12 (feature 32): below 900 px the sidebar is a menu from the left edge. Closed it is not drawn at all (so it takes
// no Tab stop and no room); open it is a panel over a scrim that enters by the drawer's token, and the two buttons that
// work it appear only here.
test("below 900 px the sidebar is not drawn until the menu is open, and then it is a panel from the left edge", () => {
  const phone = css.match(/@media \(max-width: 900px\)\s*{([\s\S]*?)\n}\n/)?.[1] ?? "";
  expect(phone).toMatch(/\.side\s*{\s*display:\s*none/);
  const open = phone.match(/\.side\.open\s*{([^}]*)}/)?.[1] ?? "";
  expect(open).toMatch(/display:\s*flex/);
  expect(open).toMatch(/position:\s*fixed/);
  expect(open).toMatch(/inset:\s*0 auto 0 0/);
  expect(open).toMatch(/width:\s*min\(20rem, 85vw\)/);
  expect(open).toMatch(/animation:\s*slide-in-left var\(--dur-3\) var\(--ease-out\)/);
  // the old stacked sidebar (a wrapped row of links above every page) is gone
  expect(phone).not.toMatch(/\.nav-label\s*{\s*display:\s*none/);
  expect(phone).not.toMatch(/\.nav\s*{\s*display:\s*contents/);
});

test("the menu's scrim covers the page under the panel, over the toasts, and the panel sits over the scrim", () => {
  expect(rule("button.menu-scrim")).toMatch(/position:\s*fixed/);
  const z = (selector: string) => Number(/z-index:\s*(\d+)/.exec(selector)?.[1]);
  const scrim = z(rule("button.menu-scrim"));
  expect(scrim).toBeGreaterThan(z(rule(".toasts")));
  expect(scrim).toBeLessThan(z(rule(".drawer-layer")));
  expect(css.match(/\.side\.open\s*{[^}]*z-index:\s*(\d+)/)?.[1]).toBe(String(scrim + 1));
});

test("the menu enters from the left by the drawer's distance, and the buttons that work it show only on a phone", () => {
  const frames = css.match(/@keyframes slide-in-left\s*{([\s\S]*?)\n}\n/)?.[1] ?? "";
  expect(frames).toMatch(/opacity:\s*0/);
  expect(frames).toMatch(/translateX\(calc\(var\(--move-drawer\) \* -1\)\)/);
  expect(rule("button.menu-btn,\nbutton.menu-close")).toMatch(/display:\s*none/);
  expect(css).toMatch(
    /@media \(max-width: 900px\)\s*{[\s\S]*?button\.menu-btn,\s*button\.menu-close\s*{\s*display:\s*inline-flex/,
  );
});

// UXR-12: the Phone board's top bar is one row at 390 px (menu button, breadcrumb, toggle), whatever the page is called: the
// breadcrumb takes what is left and clips, and the toggle's buttons are narrower. Wrapped, the toggle fell to a row of its own.
test("below 900 px the top bar stays one row: the breadcrumb clips, the toggle is narrower", () => {
  const phone = css.match(/@media \(max-width: 900px\)\s*{([\s\S]*?)\n}\n/)?.[1] ?? "";
  const topbar = phone.match(/\.topbar\s*{([^}]*)}/)?.[1] ?? "";
  expect(topbar).toMatch(/flex-wrap:\s*nowrap/);
  expect(topbar).toMatch(/min-height:\s*56px/);
  expect(topbar).toMatch(/background:\s*var\(--surface\)/);
  const nav = phone.match(/\.topbar nav\s*{([^}]*)}/)?.[1] ?? "";
  expect(nav).toMatch(/flex:\s*1/);
  expect(nav).toMatch(/min-width:\s*0/);
  const crumbs = phone.match(/\.crumbs\s*{([^}]*)}/)?.[1] ?? "";
  expect(crumbs).toMatch(/flex-wrap:\s*nowrap/);
  expect(crumbs).toMatch(/overflow:\s*hidden/);
  expect(crumbs).toMatch(/white-space:\s*nowrap/);
  // after the toggle's own rule, which it must outrank by coming later (the same specificity)
  const seg = css.match(/@media \(max-width: 900px\)\s*{\s*\.seg button\s*{([^}]*)}/);
  expect(seg?.[1]).toMatch(/padding:\s*0 12px/);
  expect(seg?.index).toBeGreaterThan(css.indexOf("\n.seg button {"));
});

// UXR-13 (feature 32): the login page is one card in the middle of the page, as wide as the Sign-in board's (440px at most), and a
// rule runs either side of "Or through your organization". It enters once, as a page does (the .page-enter class on the card).
test("the login page centres one 440px card, and the way in through an organization is set off by a rule either side", () => {
  const page = rule(".signin");
  expect(page).toMatch(/display:\s*grid/);
  expect(page).toMatch(/place-items:\s*center/);
  expect(page).toMatch(/min-height:\s*100vh/);
  const card = rule(".signin-card");
  expect(card).toMatch(/width:\s*min\(440px,\s*100%\)/);
  expect(card).toMatch(/padding:\s*40px/);
  expect(card).toMatch(/gap:\s*24px/);
  expect(rule(".signin-or")).toMatch(/display:\s*flex/);
  expect(css).toMatch(
    /\.signin-or::before,\s*\.signin-or::after\s*{[^}]*height:\s*1px[^}]*background:\s*var\(--border\)/,
  );
  // the button a callout carries sits under its words
  expect(rule(".callout-action")).toMatch(/margin-top:\s*12px/);
  // on a phone the card keeps the gutter the other pages have (16px), and a smaller padding
  expect(css).toMatch(
    /@media \(max-width: 600px\)\s*{\s*\.signin\s*{\s*padding:\s*16px;\s*}\s*\.signin-card\s*{\s*padding:\s*24px/,
  );
});

// UXR-14 (feature 32): Home is two columns (the checklist, then the figures) that become one on a phone; the progress bar is a
// track with a fill the width of the share done; a checklist row's one link is stretched over the row.
test("home is two columns of 1.5 to 1, one below 900 px, and the checklist row is one link big", () => {
  expect(rule(".home-grid")).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*1\.5fr\)\s*minmax\(0,\s*1fr\)/,
  );
  expect(rule(".home-grid")).toMatch(/gap:\s*24px/);
  expect(css).toMatch(
    /@media \(max-width: 900px\)\s*{[\s\S]*?\.home-grid\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  expect(rule(".home-grid .kpis")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  expect(rule(".checklist li")).toMatch(/position:\s*relative/);
  // the row carries an st- class for its glyph's colours, and none of the badge's mint wash
  expect(rule(".checklist li")).toMatch(/background:\s*transparent/);
  expect(rule(".checklist a::after")).toMatch(/position:\s*absolute/);
  expect(rule(".checklist a::after")).toMatch(/inset:\s*0/);
  // a tile's foot link is the same: the 12.5px words alone are well under a 44px target, the tile is not
  expect(rule(".kpi")).toMatch(/position:\s*relative/);
  expect(rule(".kpi-foot a::after")).toMatch(/position:\s*absolute/);
  expect(rule(".kpi-foot a::after")).toMatch(/inset:\s*0/);
  // the bar: a slate track, a fill in the ok colour as wide as the share (a width, so nothing slides: UXR-1 allows no transform in a transition)
  expect(rule(".bar")).toMatch(/background:\s*var\(--slate-tint\)/);
  expect(rule(".bar i")).toMatch(/background:\s*var\(--ok\)/);
  expect(rule(".bar i")).toMatch(/width:\s*calc\(var\(--p,\s*0\)\s*\*\s*100%\)/);
  expect(rule(".bar i")).not.toMatch(/transition/);
});

// UXR-15 (feature 32): Projects is what is imported beside the way to import more (1.1 to 1, one column below 1100 px); the pick
// rows, the results and the footer run to the card's edges (the card's 24px, 16px on a phone) and a picked row is tinted as well as ticked.
test("projects is two columns of 1.1 to 1, one below 1100 px, and its rows run to the card's edges", () => {
  expect(rule(".pj-grid")).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*1\.1fr\)\s*minmax\(0,\s*1fr\)/,
  );
  expect(rule(".pj-grid")).toMatch(/gap:\s*24px/);
  expect(css).toMatch(
    /@media \(max-width: 1100px\)\s*{\s*\.pj-grid\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  // the card pads 24px (16px on a phone), so the negative margins are the same literals
  expect(rule("fieldset.pj-list")).toMatch(/margin:\s*0\s+-24px/);
  expect(rule(".pj-foot")).toMatch(/margin-bottom:\s*-24px/);
  expect(css).toMatch(
    /@media \(max-width: 600px\)\s*{\s*fieldset\.pj-list,\s*\.pj-res,\s*\.pj-foot\s*{\s*margin-inline:\s*-16px/,
  );
  // a row is at least a 44px target; picked is the aqua tint beside the ticked box
  expect(rule(".pj-pick")).toMatch(/min-height:\s*52px/);
  expect(rule(".pj-pick.on")).toMatch(/background:\s*var\(--aqua-tint\)/);
  expect(rule(".pj-pick")).toMatch(/transition:\s*background-color var\(--dur-1\)/);
  expect(rule(".pj-pick")).not.toMatch(/transition:[^;]*(transform|width)/);
});

test("the repository address field takes the width the Find button leaves", () => {
  expect(rule(".pj-address label")).toMatch(/flex:\s*1 1 14rem/);
  expect(rule(".pj-address label")).toMatch(/min-width:\s*0/);
});

// UXR-16 (feature 32): the wizard's stepper is four segments (two on a phone), each a bar on top that fades to ok when done and to
// action on the current step; a template or delivery card is a tile that tints when chosen; the diff is a box with a height of its own.
test("the stepper is four segments, two on a phone, whose bar fades to ok or action", () => {
  expect(rule(".steps")).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  expect(css).toMatch(
    /@media \(max-width: 600px\)\s*{\s*\.steps\s*{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  );
  expect(rule(".steps li::after")).toMatch(/height:\s*4px/);
  expect(rule(".steps li::after")).toMatch(/background:\s*var\(--line-strong\)/);
  // a colour that fades: UXR-1 allows no transform or width in a transition
  expect(rule(".steps li::after")).toMatch(/transition:\s*background-color var\(--dur-2\)/);
  expect(rule(".steps li::after")).not.toMatch(/transition:[^;]*(transform|width)/);
  expect(rule(".steps li.done::after")).toMatch(/background:\s*var\(--ok\)/);
  expect(rule('.steps li[aria-current="step"]::after')).toMatch(/background:\s*var\(--action\)/);
  // what was chosen is read under the name, on one line cut short
  expect(rule(".steps .cap")).toMatch(/text-overflow:\s*ellipsis/);
  expect(rule(".steps .cap")).toMatch(/white-space:\s*nowrap/);
});

test("a template or delivery card is a tile that tints when chosen and rings when focused", () => {
  const card = rule(".cards .item");
  expect(card).toMatch(/border:\s*1px solid var\(--border\)/);
  expect(card).toMatch(/border-radius:\s*var\(--r-md\)/);
  expect(card).toMatch(/min-height:\s*44px/);
  expect(card).toMatch(
    /transition:\s*border-color var\(--dur-1\)[^;]*background-color var\(--dur-1\)/,
  );
  expect(card).not.toMatch(/transition:[^;]*(transform|width)/);
  expect(rule(".cards .item:has(input:checked)")).toMatch(/border-color:\s*var\(--action\)/);
  expect(rule(".cards .item:has(input:checked)")).toMatch(/background:\s*var\(--aqua-tint\)/);
  expect(rule(".cards .item:has(input:focus-visible)")).toMatch(
    /outline:\s*3px solid var\(--focus\)/,
  );
});

test("the diff scrolls in a box of its own, and an added or removed line is tinted across its width", () => {
  const box = rule(".diff");
  expect(box).toMatch(/max-height:\s*380px/);
  expect(box).toMatch(/overflow:\s*auto/);
  // one column as wide as the longest line, so a tint runs the whole way when the box scrolls sideways
  expect(box).toMatch(/grid-template-columns:\s*minmax\(max-content,\s*1fr\)/);
  expect(rule(".diff-add")).toMatch(/background:\s*var\(--mint\)/);
  expect(rule(".diff-add")).toMatch(/color:\s*var\(--ok\)/);
  expect(rule(".diff-del")).toMatch(/background:\s*var\(--danger-tint\)/);
  expect(rule(".diff-del")).toMatch(/color:\s*var\(--danger\)/);
});

test("a list inside a callout sits close under its title, not a browser margin away", () => {
  expect(rule(".callout ul")).toMatch(/margin:\s*8px 0 0/);
  expect(rule(".callout p")).toMatch(/margin:\s*8px 0 0/);
});
