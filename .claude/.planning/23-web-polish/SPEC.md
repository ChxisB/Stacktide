# 23 Web polish - Spec
Prefix: PLS · Milestone: M5 · Status: building · Needs: 22 (web-redesign)

## Goal
Make every screen spacious, clean and easy to use. Feature 22 gave the screens the Carebell look; looking at the real pages (2026-10-20, dark, 1280 px, all ten read by eye) shows they are still cramped and uneven. This feature changes spacing, table layout and the weight of buttons. It changes no behaviour, no API and no markup that a test finds by role or name.

## What the audit found
- **Variables matrix** (the worst): every cell stacks a value, two or three tags and four or five bordered 44 px pills, so a row holds about fifteen buttons.
- **Names break mid-word** in row headers (`DATABASE_` / `URL`, `feature/sear` / `ch`) because they use `overflow-wrap: anywhere`.
- **Times wrap** onto two lines on the Status page.
- **Fields stretch** across the page: the Project select is about 950 px wide for `acme/web`.
- **Uneven rhythm in cards**: paragraphs keep their browser margins on top of the card's own gap, so a heading, a paragraph and a table are separated by gaps of 16, 30 and 48 px. Sub-headings (`h3`) have no style at all.
- **Row actions are heavy**: every Retry, Dismiss, Test and Delete is a large outlined pill with a long name (`Dismiss test/fixtures/key.txt:1`).
- **Checklist** on Home runs the link and its hint together on one line.
- **Sparse or crowded spots**: Sync with no targets is one loose line outside any card; the Projects "Connection" row is out of line with its button.

## Scope
CSS first (rhythm, field width, tables, compact row buttons), then the few places where markup must change: a short visible label with the full name kept for assistive technology (Retry, Dismiss, Test), the checklist, and the Sync empty state. Then a look at every page in both themes at three widths, reading every shot.

## Non-goals
- New features or screens (charts, logs viewer, Stacks: see ROADMAP backlog).
- Hiding actions in menus or disclosures: a closed menu would take the buttons out of the page and out of every test that finds them. Actions stay visible, only quieter.
- Changing what a screen says or does, or any API.
- A new dependency.

## Design
- **Keep the markup, change the skin** (as in 22). A test that finds a button by its name keeps finding it: a shortened visible label keeps the whole name through `aria-label` or a visually hidden span.
- **One rhythm**: inside a card, the card's gap is the only space between its parts (`.card-flow > *` has no margin of its own); a sub-heading starts a section with a rule above it. Cards sit 24 px apart, 28 px padding (16 px under 600 px).
- **Fields** stop at 30 rem; textareas keep the full width.
- **Tables**: names keep whole words, times never wrap, 16 px cell padding, and buttons inside a table are compact (32 px, 13 px type, a quiet border).
- **Variables cell**: value, then the scope tags, then a row of quiet actions; Delete is red text.
- Every size is checked in `styles.test.ts` the way feature 22 did (`rule()`), and `e2e/layout.e2e.ts` still fails on sideways scroll at 390 px.

## Acceptance
- No row header or branch name breaks inside a word at 1280 px; no time wraps.
- A page title, card title and body are separated by the same gaps on all ten pages.
- The Variables matrix holds no bordered pill buttons, and at 1280 px a cell's actions fit in at most two lines.
- All ten pages read by eye in dark and light at 1280, 1440 and 390 px, with the findings fixed or logged.
- `bun run check` and `bun run e2e` are green; no test is weakened, skipped or deleted.

## Risks
- A shorter visible label must not change what a screen reader announces. Each is tested by name.
- Tighter buttons in tables must keep a 24 px target at least (WCAG 2.2 AA target size); 32 px does.
- Cards that scroll sideways on a phone are the price of whole words in tables; the e2e checks that the page itself does not.
