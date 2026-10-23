import { ApiError } from "./api";
import { Card, Glyph, Kpi } from "./components";
import { useConnections, useProjects } from "./projects";
import { href } from "./router";

interface Step {
  title: string;
  hint: string;
  done: boolean;
  to: string;
}

/**
 * What a new organization still has to do, in order, each with its screen. A step the user cannot
 * see the state of (a member cannot read connections) is left out rather than shown wrong.
 */
export function Checklist({ orgId }: { orgId: string }) {
  const connections = useConnections(orgId);
  const projects = useProjects(orgId);
  // a checklist built from one answer would say "set up" before the other arrives, or when it fails
  const noRead = connections.error instanceof ApiError && connections.error.status === 403;
  if (projects.data === undefined || (connections.data === undefined && !noRead)) return null;
  const steps: Step[] = [];
  if (connections.data) {
    steps.push({
      title: "Connect a forge",
      hint: "Give the platform a GitLab or GitHub token to read your projects.",
      done: connections.data.length > 0,
      to: href("projects"),
    });
  }
  steps.push({
    title: "Import your projects",
    hint: "Pick the repositories to manage; each is checked to see what it is.",
    done: projects.data.length > 0,
    to: href("projects"),
  });
  const left = steps.filter((s) => !s.done).length;
  return (
    <Card label="Getting started" title={left === 0 ? "You are set up" : "Getting started"}>
      <ol className="checklist">
        {steps.map((s) => (
          <li key={s.title} className={`${s.done ? "done " : ""}st-${s.done ? "ok" : "quiet"}`}>
            <Glyph tone={s.done ? "ok" : "quiet"} />
            <span>
              <a href={s.to}>{s.title}</a>
              <span className="visually-hidden">{s.done ? " (done)" : " (to do)"}</span>
              <span className="muted"> {s.hint}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * The counts the page already has to hand, shown once both have been answered. A count
 * the user may not read (connections, for a member) is left out rather than shown as zero.
 * shortcut: no open-findings count, as findings are read per project and there is no organization-wide one.
 */
export function Tiles({ orgId }: { orgId: string }) {
  const projects = useProjects(orgId);
  const connections = useConnections(orgId);
  // wait for both answers, so a tile does not pop in after the others; only a refusal leaves a tile out,
  // as the checklist does, so a failure is never shown as "not yours to see"
  const noRead = connections.error instanceof ApiError && connections.error.status === 403;
  if (projects.data === undefined || (connections.data === undefined && !noRead)) return null;
  return (
    <section aria-label="Overview" className="kpis">
      <Kpi label="Projects imported" value={projects.data.length} />
      {connections.data && <Kpi label="Forge connections" value={connections.data.length} />}
    </section>
  );
}
