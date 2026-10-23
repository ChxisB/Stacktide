/** What the drawing of a pipeline's jobs needs of a job. */
export interface JobNode {
  id: number;
  name: string;
  stage: string;
  status: string;
}

/**
 * Pixels. A node is a box `NODE.w` wide and `NODE.h` high holding a square (`SQUARE`, centred, at the top)
 * with its name and time under it; lines meet the sides of the square. `GAP` is the space between boxes,
 * `HEAD` the height of a stage's heading above its first job, `PAD` the margin round the drawing.
 */
export const NODE = { w: 136, h: 180 } as const;
export const SQUARE = 64;
export const GAP = { x: 44, y: 12 } as const;
export const HEAD = 30;
export const PAD = 12;

export interface Placed {
  id: number;
  column: number;
  row: number;
  /** The top left of the node's box. */
  x: number;
  y: number;
}
export interface Column {
  stage: string;
  x: number;
  count: number;
}
/** Where the lines of one stage meet before they go on to the next. */
export interface Junction {
  id: string;
  /** The column on its left. */
  column: number;
  x: number;
  y: number;
}
export interface Edge {
  /** `nodeKey(id)` of a job, or the id of a junction. */
  from: string;
  to: string;
  /** An SVG path. */
  d: string;
  /** Only a line that goes into a job ends in an arrow. */
  arrow: boolean;
}
/** The child pipeline a trigger started: its jobs, to be drawn as columns of their own and joined to the trigger's node. */
export interface LaneInput {
  /** Names the lane's junctions, so it must differ from the other lanes' and from `j<n>`. */
  id: string;
  /** The `id` of the trigger's node among the pipeline's jobs. */
  from: number;
  jobs: readonly JobNode[];
}
export interface Lane {
  id: string;
  from: number;
  /** The left and top of the lane's heading, and its width; the stage headings are `HEAD` below it. */
  x: number;
  y: number;
  width: number;
  /** The top of the stage headings. */
  top: number;
  nodes: Placed[];
  columns: Column[];
}
export interface Drawing {
  nodes: Placed[];
  columns: Column[];
  junctions: Junction[];
  edges: Edge[];
  width: number;
  height: number;
  /** Only when lanes were drawn; their lines and junctions are in `edges` and `junctions` with the rest. */
  lanes?: Lane[];
}

export const nodeKey = (id: number) => `n${id}`;

const curve = (x1: number, y1: number, x2: number, y2: number) =>
  `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
const centre = (n: Placed) => n.y + SQUARE / 2;
const right = (n: Placed) => n.x + (NODE.w + SQUARE) / 2;
const left = (n: Placed) => n.x + (NODE.w - SQUARE) / 2;
const mid = (ys: number[]) => (Math.min(...ys) + Math.max(...ys)) / 2;

/**
 * One group of stages: columns from `x0` across, stage headings at `y0`, the nodes below them. `w` and `h`
 * are what it takes up, without any margin. A junction `<prefix><n>` joins each two neighbouring columns.
 */
function band(jobs: readonly JobNode[], x0: number, y0: number, prefix: string) {
  const seen = new Set<number>();
  const ordered = [...jobs]
    .sort((a, b) => a.id - b.id)
    .filter((job) => !seen.has(job.id) && seen.add(job.id));
  const stages = [...new Set(ordered.map((job) => job.stage))];
  const rows = new Map<string, number>();
  const nodes: Placed[] = [];
  const byColumn: Placed[][] = stages.map(() => []);
  for (const job of ordered) {
    const column = stages.indexOf(job.stage);
    const row = rows.get(job.stage) ?? 0;
    rows.set(job.stage, row + 1);
    const placed = {
      id: job.id,
      column,
      row,
      x: x0 + column * (NODE.w + GAP.x),
      y: y0 + HEAD + row * (NODE.h + GAP.y),
    };
    nodes.push(placed);
    byColumn[column]?.push(placed);
  }
  nodes.sort((a, b) => a.column - b.column || a.row - b.row);
  for (const list of byColumn) list.sort((a, b) => a.row - b.row);

  const columns = stages.map((stage, i) => ({
    stage,
    x: x0 + i * (NODE.w + GAP.x),
    count: rows.get(stage) ?? 0,
  }));
  const junctions: Junction[] = [];
  const edges: Edge[] = [];
  for (let c = 0; c + 1 < stages.length; c++) {
    const before = byColumn[c] ?? [];
    const after = byColumn[c + 1] ?? [];
    const junction = {
      id: `${prefix}${c}`,
      column: c,
      x: x0 + c * (NODE.w + GAP.x) + NODE.w + GAP.x / 2,
      y: mid([...before, ...after].map(centre)),
    };
    junctions.push(junction);
    for (const n of before) {
      edges.push({
        from: nodeKey(n.id),
        to: junction.id,
        d: curve(right(n), centre(n), junction.x, junction.y),
        arrow: false,
      });
    }
    for (const n of after) {
      edges.push({
        from: junction.id,
        to: nodeKey(n.id),
        d: curve(junction.x, junction.y, left(n), centre(n)),
        arrow: true,
      });
    }
  }

  const tallest = Math.max(0, ...rows.values());
  return {
    nodes,
    columns,
    junctions,
    edges,
    first: byColumn[0] ?? [],
    w: stages.length === 0 ? 0 : stages.length * NODE.w + (stages.length - 1) * GAP.x,
    h: tallest === 0 ? 0 : HEAD + tallest * NODE.h + (tallest - 1) * GAP.y,
  };
}

/**
 * Where the nodes and lines of a pipeline's jobs go (NOD-1): a column for each stage, in the order the
 * stages first appear when the jobs are taken oldest first, a row for each job in a stage, and for each
 * two neighbouring stages a junction every job of the first has a line into and every job of the second a
 * line out of (GitLab starts a stage when the one before it is done). Only numbers: no DOM is read, so the
 * same jobs give the same drawing whatever order they come in.
 * shortcut: lines follow the stages, not `needs`, which the jobs list does not give; a pipeline that uses
 * `needs` shows waits that are not there. Read `needs` (GraphQL) if that matters.
 *
 * Each lane (NOD-7) is a child pipeline a trigger among the jobs started: its own columns to the right of
 * the pipeline (one more column's pitch on), under a heading, stacked one under another, with a junction in front of its first stage that
 * the trigger has a line into. A lane whose trigger is not among the jobs, or with no jobs, is left out.
 * shortcut: the line from a trigger that is not in the last stage runs under the nodes after it; draw the
 * lanes under the pipeline instead if that reads badly.
 */
export function layout(jobs: readonly JobNode[], lanes: readonly LaneInput[] = []): Drawing {
  const main = band(jobs, PAD, PAD, "j");
  const out: Drawing = {
    nodes: main.nodes,
    columns: main.columns,
    junctions: main.junctions,
    edges: main.edges,
    width: main.w === 0 ? 0 : 2 * PAD + main.w,
    height: main.h === 0 ? 0 : 2 * PAD + main.h,
  };
  const x0 = PAD + main.w + GAP.x;
  let top = PAD;
  const placed: Lane[] = [];
  for (const lane of lanes) {
    const trigger = main.nodes.find((n) => n.id === lane.from);
    const b = band(lane.jobs, x0, top + HEAD, `${lane.id}:j`);
    if (!trigger || b.nodes.length === 0) continue;
    const entry = {
      id: `${lane.id}:in`,
      column: -1,
      x: x0 - GAP.x / 2,
      y: mid([trigger, ...b.first].map(centre)),
    };
    out.junctions.push(entry, ...b.junctions);
    out.edges.push({
      from: nodeKey(trigger.id),
      to: entry.id,
      d: curve(right(trigger), centre(trigger), entry.x, entry.y),
      arrow: false,
    });
    for (const n of b.first) {
      out.edges.push({
        from: entry.id,
        to: nodeKey(n.id),
        d: curve(entry.x, entry.y, left(n), centre(n)),
        arrow: true,
      });
    }
    out.edges.push(...b.edges);
    placed.push({
      id: lane.id,
      from: lane.from,
      x: x0,
      y: top,
      width: b.w,
      top: top + HEAD,
      nodes: b.nodes,
      columns: b.columns,
    });
    out.width = Math.max(out.width, x0 + b.w + PAD);
    out.height = Math.max(out.height, top + HEAD + b.h + PAD);
    top += HEAD + b.h + 2 * GAP.y;
  }
  if (placed.length > 0) out.lanes = placed;
  return out;
}
