import { describe, expect, test } from "bun:test";
import { BOX, GAP, type GraphStack, layout, PAD } from "./run-graph-layout";

const s = (name: string, wave: number, ...dependsOn: string[]): GraphStack => ({
  name,
  dependsOn,
  wave,
});
const box = (d: ReturnType<typeof layout>, name: string) => {
  const b = d.boxes.find((x) => x.name === name);
  if (!b) throw new Error(`no box ${name}`);
  return b;
};
const colX = (column: number) => PAD + column * (BOX.w + GAP.x);
const rowY = (row: number) => PAD + row * (BOX.h + GAP.y);

describe("laying out the stacks of a run", () => {
  test("a wave is a column and the names in it are rows in order", () => {
    const d = layout([s("db", 1, "net"), s("net", 0), s("cache", 1, "net"), s("app", 2, "db")]);
    expect(d.boxes.map((b) => [b.name, b.column, b.row, b.x, b.y])).toEqual([
      ["net", 0, 0, colX(0), rowY(0)],
      ["cache", 1, 0, colX(1), rowY(0)],
      ["db", 1, 1, colX(1), rowY(1)],
      ["app", 2, 0, colX(2), rowY(0)],
    ]);
  });

  test("the drawing is as wide as its columns and as tall as its fullest column", () => {
    const d = layout([s("a", 0), s("b", 1, "a"), s("c", 1, "a"), s("d", 2, "b", "c")]);
    expect([d.width, d.height]).toEqual([
      2 * PAD + 3 * BOX.w + 2 * GAP.x,
      2 * PAD + 2 * BOX.h + GAP.y,
    ]);
    expect(layout([s("alone", 0)])).toMatchObject({
      width: 2 * PAD + BOX.w,
      height: 2 * PAD + BOX.h,
      edges: [],
    });
  });

  test("the order the stacks are given in changes nothing", () => {
    const stacks = [s("a", 0), s("b", 1, "a"), s("c", 1, "a"), s("d", 2, "b", "c")];
    const once = JSON.stringify(layout(stacks));
    expect(JSON.stringify(layout([...stacks].reverse()))).toBe(once);
    expect(
      JSON.stringify(layout([stacks[2], stacks[0], stacks[3], stacks[1]] as GraphStack[])),
    ).toBe(once);
  });

  test("a line leaves the right side of the stack waited for and enters the left side of the one waiting", () => {
    const d = layout([s("a", 0), s("b", 1, "a"), s("c", 2, "b")]);
    expect(d.edges.map((e) => [e.from, e.to, e.lane])).toEqual([
      ["a", "b", null],
      ["b", "c", null],
    ]);
    const [ab] = d.edges;
    const a = box(d, "a");
    const b = box(d, "b");
    expect(ab?.d.startsWith(`M ${a.x + BOX.w} ${a.y + BOX.h / 2} `)).toBe(true);
    expect(ab?.d.endsWith(` ${b.x} ${b.y + BOX.h / 2}`)).toBe(true);
  });

  test("a diamond has four lines", () => {
    const d = layout([s("a", 0), s("b", 1, "a"), s("c", 1, "a"), s("d", 2, "b", "c")]);
    expect(d.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b", "a>c", "b>d", "c>d"]);
  });

  test("a line that skips a column runs in the gap between rows, so it crosses no box", () => {
    const d = layout([s("a", 0), s("b", 1, "a"), s("c", 2, "a", "b")]);
    const skip = d.edges.find((e) => e.from === "a" && e.to === "c");
    const b = box(d, "b");
    expect(skip?.lane).not.toBeNull();
    const lane = skip?.lane as number;
    // in the drawing, and in none of the boxes of the column it passes
    expect(lane).toBeGreaterThanOrEqual(0);
    expect(lane).toBeLessThanOrEqual(d.height);
    expect(lane < b.y || lane > b.y + BOX.h).toBe(true);
    // the line is level with that gap from the first column's gutter to the last one's
    const a = box(d, "a");
    const c = box(d, "c");
    expect(skip?.d).toContain(`L ${c.x - GAP.x} ${lane}`);
    expect(skip?.d.startsWith(`M ${a.x + BOX.w} ${a.y + BOX.h / 2} `)).toBe(true);
    // the neighbours' lines are not skipping
    expect(d.edges.filter((e) => e.lane === null).length).toBe(2);
  });

  test("a name that is not in the list, or a stack that is not in an earlier column, has no line", () => {
    const d = layout([s("a", 0, "missing", "b"), s("b", 0), s("c", 1, "c", "a")]);
    expect(d.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a>c"]);
  });

  test("nothing to draw is an empty drawing", () => {
    expect(layout([])).toEqual({ boxes: [], edges: [], width: 0, height: 0 });
  });
});
