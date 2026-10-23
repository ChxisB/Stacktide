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

// the rules a real browser showed to matter at 390px and at 1440px
const rule = (selector: string) =>
  css.match(
    new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`),
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

// feature 23: the rhythm the real pages showed was missing
test("a card's parts are one gap apart, with no browser margin on top of it", () => {
  expect(rule(".card-flow")).toMatch(/gap:\s*20px/);
  expect(rule(".card-flow > *")).toMatch(/margin:\s*0/);
  expect(rule(".card")).toMatch(/padding:\s*28px/);
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

test("table cells are roomy, and a button in one is compact with a quiet border", () => {
  expect(css.match(/\nth,\s*td\s*{([^}]*)}/)?.[1]).toMatch(/padding:\s*10px 16px/);
  const compact = css.match(/\ntd button,\s*td \.button\s*{([^}]*)}/)?.[1] ?? "";
  expect(compact).toMatch(/min-height:\s*32px/);
  expect(compact).toMatch(/font-size:\s*13px/);
  expect(compact).toMatch(/border-color:\s*var\(--line-strong\)/);
});

test("a quiet action is plain words: no border, body text, Delete in the danger colour", () => {
  const quiet = rule("button.quiet");
  expect(quiet).toMatch(/border-color:\s*transparent/);
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
  expect(rule(".stack.card")).toMatch(/gap:\s*20px/);
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

// DEP-14: the lines of a promotion's dry-run answer sit close together, whatever the paragraphs' own margins
test("the dry-run answer of a promotion is a tight column of lines", () => {
  expect(rule(".deploy-plan")).toMatch(/display:\s*grid/);
  expect(rule(".deploy-plan")).toMatch(/gap:\s*6px/);
  expect(rule(".deploy-plan p")).toMatch(/margin:\s*0/);
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

// VUI-4: a row's own buttons show for the row being pointed at or worked in (always on a touch screen); the ⋯ menu floats
test("a row's buttons stay reachable by keyboard and show on hover, on focus within, and always where there is no hover", () => {
  const actions = rule("td.row-actions");
  expect(actions).toMatch(/opacity:\s*0/);
  // hidden by opacity, never by display: a Tab must still land on them, which is what shows the rest
  expect(actions).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  expect(actions).toMatch(/white-space:\s*nowrap/);
  expect(actions).toMatch(/text-align:\s*right/);
  expect(css).toMatch(
    /tr:hover td\.row-actions,\s*tr:focus-within td\.row-actions\s*{[^}]*opacity:\s*1/,
  );
  expect(css).toMatch(/@media \(hover: none\)\s*{\s*td\.row-actions\s*{[^}]*opacity:\s*1/);
  // the picture buttons of a row are as tall as the row's other buttons
  expect(rule(".row-actions button.icon")).toMatch(/width:\s*32px/);
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

test("a line's buttons are there for a Tab and shown for the line that is pointed at or worked in, and always where nothing hovers", () => {
  expect(rule(".line-actions")).toMatch(/opacity:\s*0/);
  expect(rule(".line-actions")).toMatch(/margin-left:\s*auto/);
  expect(css).toMatch(
    /\.env-line:hover \.line-actions,\s*\.env-line:focus-within \.line-actions\s*{[^}]*opacity:\s*1/,
  );
  expect(css).toMatch(/@media \(hover: none\)\s*{\s*\.line-actions\s*{[^}]*opacity:\s*1/);
  expect(rule(".line-actions button.icon")).toMatch(/width:\s*32px/);
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
  expect(rule(".matrix tbody tr:hover th:first-child")).toMatch(
    /background:\s*var\(--slate-tint\)/,
  );
});
