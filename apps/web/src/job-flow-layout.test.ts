import { describe, expect, test } from "bun:test";
import { GAP, HEAD, type JobNode, layout, NODE, nodeKey, PAD, SQUARE } from "./job-flow-layout";

const j = (id: number, stage: string, name = `job-${id}`, status = "success"): JobNode => ({
  id,
  name,
  stage,
  status,
});
const node = (d: ReturnType<typeof layout>, id: number) => {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};
const colX = (column: number) => PAD + column * (NODE.w + GAP.x);
const rowY = (row: number) => PAD + HEAD + row * (NODE.h + GAP.y);
/** The numbers of a path, in order. */
const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** Where a path ends. */
const end = (d: string) => nums(d).slice(-2) as [number, number];
const start = (d: string) => nums(d).slice(0, 2) as [number, number];
/** The square of a node: the part a line may not end inside. */
const squareOf = (n: { x: number; y: number }) => ({
  left: n.x + (NODE.w - SQUARE) / 2,
  top: n.y,
  right: n.x + (NODE.w + SQUARE) / 2,
  bottom: n.y + SQUARE,
});

describe("laying out the jobs of a pipeline", () => {
  test("a stage is a column, in the order the stages first appear, and its jobs are rows in order", () => {
    const d = layout([j(1, "build"), j(2, "test"), j(3, "test"), j(4, "deploy")]);
    expect(d.nodes.map((n) => [n.id, n.column, n.row, n.x, n.y])).toEqual([
      [1, 0, 0, colX(0), rowY(0)],
      [2, 1, 0, colX(1), rowY(0)],
      [3, 1, 1, colX(1), rowY(1)],
      [4, 2, 0, colX(2), rowY(0)],
    ]);
    expect(d.columns.map((c) => [c.stage, c.x, c.count])).toEqual([
      ["build", colX(0), 1],
      ["test", colX(1), 2],
      ["deploy", colX(2), 1],
    ]);
  });

  test("a stage whose jobs are not together in the list is still one column", () => {
    const d = layout([j(1, "build"), j(2, "test"), j(3, "build")]);
    expect(d.columns.map((c) => [c.stage, c.count])).toEqual([
      ["build", 2],
      ["test", 1],
    ]);
    expect(d.nodes.map((n) => [n.id, n.column, n.row])).toEqual([
      [1, 0, 0],
      [3, 0, 1],
      [2, 1, 0],
    ]);
  });

  test("the drawing is as wide as its columns and as tall as its fullest column", () => {
    const d = layout([j(1, "a"), j(2, "b"), j(3, "b"), j(4, "c")]);
    expect([d.width, d.height]).toEqual([
      2 * PAD + 3 * NODE.w + 2 * GAP.x,
      PAD + HEAD + 2 * NODE.h + GAP.y + PAD,
    ]);
    expect(layout([j(1, "only")])).toMatchObject({
      width: 2 * PAD + NODE.w,
      height: PAD + HEAD + NODE.h + PAD,
      edges: [],
      junctions: [],
    });
  });

  test("the order the jobs are given in changes nothing", () => {
    const jobs = [j(1, "build"), j(2, "test"), j(3, "test"), j(4, "deploy")];
    const once = JSON.stringify(layout(jobs));
    expect(JSON.stringify(layout([...jobs].reverse()))).toBe(once);
    expect(JSON.stringify(layout([jobs[2], jobs[0], jobs[3], jobs[1]] as JobNode[]))).toBe(once);
  });

  test("a job given twice is drawn once", () => {
    expect(layout([j(1, "a"), j(1, "a"), j(2, "a")]).nodes.map((n) => n.id)).toEqual([1, 2]);
  });

  test("an empty pipeline is an empty drawing", () => {
    expect(layout([])).toEqual({
      nodes: [],
      columns: [],
      junctions: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });
});

describe("the lines between stages", () => {
  const d = layout([j(1, "build"), j(2, "test"), j(3, "test"), j(4, "deploy")]);

  test("one stage has no junction and no line; each pair of neighbours has one junction", () => {
    expect(layout([j(1, "a"), j(2, "a")])).toMatchObject({ junctions: [], edges: [] });
    expect(d.junctions.map((x) => x.column)).toEqual([0, 1]);
  });

  test("every job of a stage has a line into the junction after it, and every job of the next stage a line out of it", () => {
    const pairs = d.edges.map((e) => [e.from, e.to]);
    expect(pairs).toEqual([
      [nodeKey(1), "j0"],
      ["j0", nodeKey(2)],
      ["j0", nodeKey(3)],
      [nodeKey(2), "j1"],
      [nodeKey(3), "j1"],
      ["j1", nodeKey(4)],
    ]);
  });

  test("only the lines that go into a job have an arrow", () => {
    expect(d.edges.map((e) => [e.to.startsWith("j"), e.arrow])).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [true, false],
      [true, false],
      [false, true],
    ]);
  });

  test("a line leaves the right of a square, and ends at the left of the next one, and at the junction for the first half", () => {
    const [into] = d.edges;
    const a = node(d, 1);
    const sq = squareOf(a);
    expect(start(into?.d ?? "")).toEqual([sq.right, a.y + SQUARE / 2]);
    const j0 = d.junctions[0] ?? { x: Number.NaN, y: Number.NaN };
    expect(end(into?.d ?? "")).toEqual([j0.x, j0.y]);
    const out = d.edges.find((e) => e.to === nodeKey(3));
    const c = node(d, 3);
    expect(end(out?.d ?? "")).toEqual([squareOf(c).left, c.y + SQUARE / 2]);
    expect(start(out?.d ?? "")).toEqual([j0.x, j0.y]);
  });

  test("a junction is in the middle of the gap between two columns, level with the middle of the jobs either side", () => {
    const [j0, j1] = d.junctions;
    expect(j0?.x).toBe(colX(0) + NODE.w + GAP.x / 2);
    expect(j1?.x).toBe(colX(1) + NODE.w + GAP.x / 2);
    // column 1 has two jobs: the junction before them and after them sits between the centres of the jobs of both sides
    const mid = (ys: number[]) => (Math.min(...ys) + Math.max(...ys)) / 2;
    const c = (id: number) => node(d, id).y + SQUARE / 2;
    expect(j0?.y).toBe(mid([c(1), c(2), c(3)]));
    expect(j1?.y).toBe(mid([c(2), c(3), c(4)]));
  });

  test("no line ends inside the square of a job", () => {
    for (const e of d.edges) {
      const [x, y] = end(e.d);
      for (const n of d.nodes) {
        const s = squareOf(n);
        const inside = x > s.left && x < s.right && y > s.top && y < s.bottom;
        expect(inside).toBe(false);
      }
    }
  });
});

describe("the child pipelines a trigger started, as lanes (NOD-7)", () => {
  // a pipeline of three stages whose last stage holds a job and a trigger (id 4), and one child of three jobs
  const main = [j(1, "build"), j(2, "test"), j(3, "deploy"), j(4, "deploy", "launch")];
  const child = {
    id: "c1",
    from: 4,
    jobs: [j(10, "test"), j(11, "test"), j(12, "deploy")],
  };
  const d = layout(main, [child]);
  const lane = d.lanes?.[0];
  const mainRight = PAD + 3 * NODE.w + 2 * GAP.x;
  // a lane is one more column to the right, at the pitch of the stages (read from the 1280 picture: with twice the gap, four
  // stages and a lane were 41px wider than the card)
  const laneX = mainRight + GAP.x;
  const boxes = (x: ReturnType<typeof layout>) =>
    [...x.nodes, ...(x.lanes ?? []).flatMap((l) => l.nodes)].map((n) => ({
      id: n.id,
      left: n.x,
      top: n.y,
      right: n.x + NODE.w,
      bottom: n.y + NODE.h,
    }));
  const apart = (a: ReturnType<typeof boxes>[number], b: typeof a) =>
    a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

  test("a drawing without lanes has none, and an empty list of them changes nothing", () => {
    expect(layout(main).lanes).toBeUndefined();
    expect(layout(main, [])).toEqual(layout(main));
  });

  test("the pipeline's own nodes and columns stay where they were", () => {
    const own = layout(main);
    expect(d.nodes).toEqual(own.nodes);
    expect(d.columns).toEqual(own.columns);
  });

  test("a lane sits to the right of the pipeline, under a heading of its own, with its stages as columns", () => {
    expect(lane?.id).toBe("c1");
    expect([lane?.x, lane?.y, lane?.width]).toEqual([laneX, PAD, 2 * NODE.w + GAP.x]);
    expect(lane?.columns.map((c) => [c.stage, c.x, c.count])).toEqual([
      ["test", laneX, 2],
      ["deploy", laneX + NODE.w + GAP.x, 1],
    ]);
    // the stage headings are below the lane's heading, and the nodes below them
    expect(lane?.top).toBe(PAD + HEAD);
    expect(lane?.nodes.map((n) => [n.id, n.column, n.row, n.x, n.y])).toEqual([
      [10, 0, 0, laneX, PAD + 2 * HEAD],
      [11, 0, 1, laneX, PAD + 2 * HEAD + NODE.h + GAP.y],
      [12, 1, 0, laneX + NODE.w + GAP.x, PAD + 2 * HEAD],
    ]);
  });

  test("the trigger has a line into a junction before the lane, and from it to each job of the lane's first stage", () => {
    const into = d.edges.filter((e) => e.from === nodeKey(4));
    expect(into.map((e) => [e.to, e.arrow])).toEqual([["c1:in", false]]);
    const out = d.edges.filter((e) => e.from === "c1:in");
    expect(out.map((e) => [e.to, e.arrow])).toEqual([
      [nodeKey(10), true],
      [nodeKey(11), true],
    ]);
    const trigger = node(d, 4);
    const sq = squareOf(trigger);
    expect(start(into[0]?.d ?? "")).toEqual([sq.right, trigger.y + SQUARE / 2]);
    const junction = d.junctions.find((x) => x.id === "c1:in") ?? { x: Number.NaN, y: Number.NaN };
    expect(end(into[0]?.d ?? "")).toEqual([junction.x, junction.y]);
    // in the gap before the lane's first column
    expect(junction.x).toBe(laneX - GAP.x / 2);
    for (const e of out) {
      const n = lane?.nodes.find((x) => nodeKey(x.id) === e.to);
      expect(end(e.d)).toEqual([squareOf(n ?? { x: 0, y: 0 }).left, (n?.y ?? 0) + SQUARE / 2]);
    }
  });

  test("the lane has junctions between its own stages, named for the lane, and no name is used twice", () => {
    expect(d.junctions.map((x) => x.id)).toEqual(["j0", "j1", "c1:in", "c1:j0"]);
    const keys = d.edges.map((e) => `${e.from}>${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 4 lines for the pipeline's three stages (1 + 2 + 1... counted below), 1 + 2 for the way in, 3 inside the lane
    expect(d.edges.length).toBe(layout(main).edges.length + 1 + 2 + 3);
  });

  test("no node is on another, and the drawing holds them all", () => {
    const all = boxes(d);
    for (const a of all) for (const b of all) if (a.id !== b.id) expect(apart(a, b)).toBe(true);
    expect(d.width).toBeGreaterThanOrEqual(Math.max(...all.map((b) => b.right)) + PAD);
    expect(d.height).toBeGreaterThanOrEqual(Math.max(...all.map((b) => b.bottom)) + PAD);
    expect(d.width).toBe(laneX + 2 * NODE.w + GAP.x + PAD);
  });

  test("lanes stack one under the other, in the order given, and do not overlap", () => {
    const second = { id: "c2", from: 4, jobs: [j(20, "test"), j(21, "test"), j(22, "test")] };
    const two = layout(main, [child, second]);
    const [a, b] = two.lanes ?? [];
    expect([a?.id, b?.id]).toEqual(["c1", "c2"]);
    expect(a?.x).toBe(b?.x);
    // the second lane's heading is below the first lane's tallest column (2 rows), with a gap
    const bottomOfFirst = (a?.top ?? 0) + HEAD + 2 * NODE.h + GAP.y;
    expect(b?.y ?? 0).toBeGreaterThan(bottomOfFirst);
    const all = boxes(two);
    for (const p of all) for (const q of all) if (p.id !== q.id) expect(apart(p, q)).toBe(true);
    expect(two.height).toBeGreaterThanOrEqual(Math.max(...all.map((x) => x.bottom)) + PAD);
    // both lanes start from the same trigger
    expect(two.edges.filter((e) => e.from === nodeKey(4)).map((e) => e.to)).toEqual([
      "c1:in",
      "c2:in",
    ]);
  });

  test("a lane whose trigger is not in the pipeline, or with no jobs, is not drawn", () => {
    const d2 = layout(main, [
      { id: "orphan", from: 999, jobs: [j(30, "test")] },
      { id: "empty", from: 4, jobs: [] },
    ]);
    expect(d2.lanes ?? []).toEqual([]);
    expect(d2.edges).toEqual(layout(main).edges);
    expect(d2.width).toBe(layout(main).width);
  });

  test("the order the jobs are given in changes nothing", () => {
    const flipped = layout([...main].reverse(), [{ ...child, jobs: [...child.jobs].reverse() }]);
    expect(flipped).toEqual(d);
  });

  test("a pipeline of one trigger alone draws it as a node, and a lane from it", () => {
    const only = layout([j(1, "deploy", "launch")], [{ id: "c1", from: 1, jobs: [j(5, "test")] }]);
    expect(only.nodes.map((n) => n.id)).toEqual([1]);
    expect(only.lanes?.[0]?.nodes.map((n) => n.id)).toEqual([5]);
    expect(only.edges.map((e) => e.to)).toEqual(["c1:in", nodeKey(5)]);
  });
});
