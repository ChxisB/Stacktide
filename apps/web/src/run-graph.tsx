import { StatusBadge, type Tone } from "./components";
import { BOX, type GraphStack, layout } from "./run-graph-layout";

/** A stack of a run as the graph draws it: where it goes, and how it is doing, already in words. */
export interface GraphNode extends GraphStack {
  label: string;
  tone: Tone;
  dns: boolean;
}

/**
 * The stacks of a run as boxes in columns, a line from each stack to the stacks waiting for it (FLW-3).
 * Read-only. The drawing is for the eye; the same order is a hidden list for a screen reader, and the
 * state is a word and a shape in every box. Positions are set through the CSSOM, which a strict
 * `style-src` allows. The box row scrolls inside its own container.
 */
export function RunGraph({ stacks }: { stacks: readonly GraphNode[] }) {
  const drawing = layout(stacks);
  const byName = new Map(stacks.map((s) => [s.name, s]));
  return (
    <>
      <div className="run-graph">
        <div
          className="run-graph-canvas"
          aria-hidden="true"
          style={{ width: drawing.width, height: drawing.height }}
        >
          <svg
            className="run-graph-edges"
            width={drawing.width}
            height={drawing.height}
            aria-hidden="true"
            focusable="false"
          >
            {drawing.edges.map((e) => (
              <path key={`${e.from}>${e.to}`} className="run-graph-edge" d={e.d} />
            ))}
          </svg>
          {drawing.boxes.map((b) => {
            const s = byName.get(b.name);
            return (
              <div
                key={b.name}
                className="run-graph-box"
                style={{ left: b.x, top: b.y, width: BOX.w, height: BOX.h }}
              >
                <span className="run-graph-name">{b.name}</span>
                <span className="row">
                  {s && <StatusBadge tone={s.tone}>{s.label}</StatusBadge>}
                  {s?.dns && <span className="tag">DNS zone</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <ul className="visually-hidden">
        {drawing.edges.map((e) => (
          <li key={`${e.from}>${e.to}`}>{`${e.to} waits for ${e.from}`}</li>
        ))}
      </ul>
    </>
  );
}
