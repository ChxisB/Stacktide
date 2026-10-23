/** What a graph of a run needs of a stack: its name, the stacks of the run it waits for, and its column (the API's `wave`). */
export interface GraphStack {
  name: string;
  dependsOn: readonly string[];
  wave: number;
}

/** The size of a box, the space between boxes, and the margin round the drawing, in pixels. */
export const BOX = { w: 208, h: 52 } as const;
export const GAP = { x: 64, y: 16 } as const;
export const PAD = 12;

export interface Box {
  name: string;
  column: number;
  row: number;
  x: number;
  y: number;
}
export interface Edge {
  /** The stack that is waited for. */
  from: string;
  /** The stack that waits. */
  to: string;
  /** An SVG path from the right side of `from` to the left side of `to`. */
  d: string;
  /** For a line that skips a column: the height it runs at, in the gap between two rows so it crosses no box. Null otherwise. */
  lane: number | null;
}
export interface Drawing {
  boxes: Box[];
  edges: Edge[];
  width: number;
  height: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Where the boxes and lines of a run's graph go (FLW-2): a column for each wave, the names of a column
 * in order down it, a line from each stack to the stacks waiting for it. Only numbers: no DOM is read,
 * so the same stacks give the same drawing whatever order they come in. A dependency that is not in the
 * list, or not in an earlier column, has no line.
 */
export function layout(stacks: readonly GraphStack[]): Drawing {
  const byName = new Map<string, GraphStack>();
  for (const st of [...stacks].sort((a, b) => cmp(a.name, b.name))) {
    if (!byName.has(st.name)) byName.set(st.name, st);
  }
  // a wave that no stack is in (an answer this version does not expect) leaves no empty column
  const waves = [...new Set([...byName.values()].map((st) => st.wave))].sort((a, b) => a - b);
  const columnOf = new Map([...byName.values()].map((st) => [st.name, waves.indexOf(st.wave)]));
  const rows = new Map<number, number>();
  const boxes = new Map<string, Box>();
  for (const st of byName.values()) {
    const column = columnOf.get(st.name) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    boxes.set(st.name, {
      name: st.name,
      column,
      row,
      x: PAD + column * (BOX.w + GAP.x),
      y: PAD + row * (BOX.h + GAP.y),
    });
  }

  const edges: Edge[] = [];
  for (const to of boxes.values()) {
    for (const name of [...new Set(byName.get(to.name)?.dependsOn)].sort(cmp)) {
      const from = boxes.get(name);
      if (!from || from.column >= to.column) continue;
      const x1 = from.x + BOX.w;
      const y1 = from.y + BOX.h / 2;
      const y2 = to.y + BOX.h / 2;
      if (to.column - from.column === 1) {
        const k = GAP.x / 2;
        edges.push({
          from: name,
          to: to.name,
          d: `M ${x1} ${y1} C ${x1 + k} ${y1} ${to.x - k} ${y2} ${to.x} ${y2}`,
          lane: null,
        });
        continue;
      }
      // the gap above the higher of the two rows: no box of any column is in it
      const lane = PAD + Math.min(from.row, to.row) * (BOX.h + GAP.y) - GAP.y / 2;
      const k = GAP.x / 2;
      edges.push({
        from: name,
        to: to.name,
        d: `M ${x1} ${y1} C ${x1 + k} ${y1} ${x1 + k} ${lane} ${x1 + GAP.x} ${lane} L ${to.x - GAP.x} ${lane} C ${to.x - k} ${lane} ${to.x - k} ${y2} ${to.x} ${y2}`,
        lane,
      });
    }
  }
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));

  const ordered = [...boxes.values()].sort((a, b) => a.column - b.column || a.row - b.row);
  const columns = waves.length;
  const tallest = Math.max(0, ...rows.values());
  return {
    boxes: ordered,
    edges,
    width: columns === 0 ? 0 : 2 * PAD + columns * BOX.w + (columns - 1) * GAP.x,
    height: tallest === 0 ? 0 : 2 * PAD + tallest * BOX.h + (tallest - 1) * GAP.y,
  };
}
