import { ApiError } from "./api";
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
      title: "Connect GitLab",
      hint: "Give the platform a token to read your projects.",
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
    <section aria-label="Getting started" className="card">
      <h2>{left === 0 ? "You are set up" : "Getting started"}</h2>
      <ol className="checklist">
        {steps.map((s) => (
          <li key={s.title} className={s.done ? "done" : undefined}>
            <span aria-hidden="true">{s.done ? "✓" : "○"}</span> <a href={s.to}>{s.title}</a>
            <span className="visually-hidden">{s.done ? " (done)" : " (to do)"}</span>
            <span className="muted"> {s.hint}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
