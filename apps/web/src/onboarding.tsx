import type { CSSProperties } from "react";
import { ApiError } from "./api";
import { Card, Glyph, Icon, Kpi } from "./components";
import { useConnections, useProjects } from "./projects";
import { href } from "./router";

interface Step {
  title: string;
  hint: string;
  done: boolean;
  to: string;
}

/** The shape of the two columns while their counts load: busy, with the one word a screen reader gets (the shapes are decoration). */
function HomeLoading() {
  return (
    <div className="home-grid" aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading
      </p>
      <div className="card card-flow" aria-hidden="true">
        <span className="skel short" />
        <span className="skel" />
        <span className="skel" />
      </div>
      <div className="kpis" aria-hidden="true">
        {[0, 1].map((n) => (
          <div key={n} className="kpi">
            <span className="skel short" />
            <span className="skel" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Where a new organization stands: what it still has to do, in order, each step with its screen, and the counts
 * the page already has to hand. Both columns wait for both answers, so nothing pops in after the other; a step or
 * a count the user cannot read (a member cannot read connections) is left out rather than shown wrong, and a failed
 * answer shows neither, rather than "set up" or zero.
 * shortcut: no open-findings count, as findings are read per project and there is no organization-wide one.
 */
export function Overview({ orgId }: { orgId: string }) {
  const connections = useConnections(orgId);
  const projects = useProjects(orgId);
  const noRead = connections.error instanceof ApiError && connections.error.status === 403;
  if (projects.isPending || connections.isPending) return <HomeLoading />;
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
  const done = steps.filter((s) => s.done).length;
  const progress = `${done} of ${steps.length} steps done`;
  return (
    <div className="home-grid">
      <Card
        label="Getting started"
        title={done === steps.length ? "You are set up" : "Getting started"}
        sub={progress}
      >
        <div
          className="bar"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-valuetext={progress}
        >
          <i style={{ "--p": done / steps.length } as CSSProperties} />
        </div>
        <ol className="checklist">
          {steps.map((s) => (
            <li key={s.title} className={`${s.done ? "done " : ""}st-${s.done ? "ok" : "quiet"}`}>
              <Glyph tone={s.done ? "ok" : "quiet"} />
              <span>
                <a href={s.to}>{s.title}</a>
                <span className="visually-hidden">{s.done ? " (done)" : " (to do)"}</span>
                <span className="muted"> {s.hint}</span>
              </span>
              <span className="go">
                <Icon name="next" />
              </span>
            </li>
          ))}
        </ol>
      </Card>
      <section aria-label="Overview" className="kpis">
        <Kpi
          label="Projects imported"
          value={projects.data.length}
          foot="View projects"
          footHref={href("projects")}
        />
        {connections.data && (
          <Kpi
            label="Forge connections"
            value={connections.data.length}
            foot="Manage connections"
            footHref={href("settings")}
          />
        )}
      </section>
    </div>
  );
}
