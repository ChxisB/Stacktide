import { useId } from "react";
import { Named, StatusBadge, type Tone } from "./components";
import {
  type Column,
  GAP,
  HEAD,
  type JobNode,
  layout,
  NODE,
  PAD,
  type Placed,
} from "./job-flow-layout";
import { webUrl } from "./pipeline-parts";

/** A job as the drawing shows it: what the layout needs, and the state, time and reason already in words. */
export interface FlowJob extends JobNode {
  label: string;
  tone: Tone;
  took: string | null;
  reason: string | null;
  /** GitLab's address of the job; shown as a link only when it is a web address. */
  url: string;
  /** A trigger starts another pipeline instead of running a script (NOD-7). */
  kind?: "trigger";
  /** A line about what the trigger started, in words; none for a job that is not a trigger. */
  note?: string | null;
  /** A second line, when what the trigger started is not drawn: why not, in words (NOD-11). */
  unseen?: string | null;
}

/** The child pipeline a trigger started, drawn to the right of the pipeline (NOD-7). */
export interface FlowLane {
  /** Names the lane's lines and its heading; unique among the lanes. */
  id: string;
  /** The `id` of the trigger among the jobs. */
  from: number;
  title: string;
  jobs: readonly FlowJob[];
}

function Node({ j }: { j: FlowJob }) {
  const link = webUrl(j.url);
  return (
    <li className={j.kind === "trigger" ? "job-trigger" : undefined} style={{ height: NODE.h }}>
      <StatusBadge tone={j.tone}>{j.label}</StatusBadge>
      {j.kind === "trigger" && <span className="job-kind">Triggers</span>}
      <code title={j.name}>{j.name}</code>
      {j.took !== null && <span className="muted">{j.took}</span>}
      {j.reason && <span className="error">{j.reason}</span>}
      {j.note && <span className="job-note">{j.note}</span>}
      {j.unseen && <span className="job-note">{j.unseen}</span>}
      {link && (
        <a href={link} target="_blank" rel="noreferrer">
          <Named word="Open job" name={j.name} />
        </a>
      )}
    </li>
  );
}

/** The stages of a pipeline or a lane: a heading and a list each, `top` down from the canvas's top. */
function Stages({
  columns,
  nodes,
  byId,
  top,
  Heading,
}: {
  columns: readonly Column[];
  nodes: readonly Placed[];
  byId: ReadonlyMap<number, FlowJob>;
  top: number;
  Heading: "h3" | "h4";
}) {
  return columns.map((c, column) => (
    <div key={c.stage} className="job-stage" style={{ left: c.x, top, width: NODE.w }}>
      <Heading className="jobs-stage" title={c.stage} style={{ height: HEAD }}>
        {c.stage}
      </Heading>
      <ul className="jobs-list" style={{ gap: GAP.y }}>
        {nodes
          .filter((n) => n.column === column)
          .map((n) => {
            const j = byId.get(n.id);
            return j && <Node key={j.id} j={j} />;
          })}
      </ul>
    </div>
  ));
}

/**
 * The jobs of a pipeline as nodes in columns, one column for each stage, with lines from each stage to
 * the next (NOD-2). Read-only. The nodes are the real content: a list for each stage under its heading,
 * in the order the pipeline runs them, each with the state in a word and a shape. The lines are for the
 * eye and are hidden from a screen reader. Positions come from `layout` and are set through the CSSOM,
 * which a strict `style-src` allows; the box scrolls inside itself.
 * A lane (NOD-7) is a group of its own, named by its heading, drawn after the pipeline's stages.
 */
export function JobFlow({
  jobs,
  lanes = [],
}: {
  jobs: readonly FlowJob[];
  lanes?: readonly FlowLane[];
}) {
  const id = useId().replaceAll(":", "");
  const arrow = `job-flow-arrow-${id}`;
  const drawing = layout(jobs, lanes);
  if (drawing.nodes.length === 0) return null;
  const byId = new Map([...jobs, ...lanes.flatMap((l) => l.jobs)].map((j) => [j.id, j]));
  return (
    <div className="job-flow">
      <div className="job-flow-canvas" style={{ width: drawing.width, height: drawing.height }}>
        <svg
          className="job-flow-edges"
          width={drawing.width}
          height={drawing.height}
          aria-hidden="true"
          focusable="false"
        >
          <marker
            id={arrow}
            className="job-flow-arrow"
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8z" />
          </marker>
          {drawing.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              className="job-flow-edge"
              d={e.d}
              markerEnd={e.arrow ? `url(#${arrow})` : undefined}
            />
          ))}
          {drawing.junctions.map((j) => (
            <circle key={j.id} className="job-flow-junction" cx={j.x} cy={j.y} r={3} />
          ))}
        </svg>
        <Stages
          columns={drawing.columns}
          nodes={drawing.nodes}
          byId={byId}
          top={PAD}
          Heading="h3"
        />
        {drawing.lanes?.map((l) => {
          const title = `${arrow}-${l.id}`;
          return (
            <section key={l.id} aria-labelledby={title}>
              <div className="job-stage" style={{ left: l.x, top: l.y, width: l.width }}>
                <h3
                  id={title}
                  className="jobs-stage job-lane-title"
                  title={lanes.find((x) => x.id === l.id)?.title}
                  style={{ height: HEAD }}
                >
                  {lanes.find((x) => x.id === l.id)?.title}
                </h3>
              </div>
              <Stages columns={l.columns} nodes={l.nodes} byId={byId} top={l.top} Heading="h4" />
            </section>
          );
        })}
      </div>
    </div>
  );
}
